//! E-AC-3 input. The core is decoded by an FFmpeg child (its decoder handles AHT); the renderer
//! feeds it the same bytes it reads and takes its PCM back as WAV, for the channel layout. Each
//! access unit's EMDF (OAMD and JOC) comes from the bitstream; JOC rebuilds the objects from the
//! core. Without JOC the core channels render as beds at Dolby's positions.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use crate::direct::{Mode, bed_position};
use crate::input::{Block, Feed};
use crate::joc::{Upmix, find_container};
use crate::objects::{Kind, Scene};
use crate::render::Source;

/// One access unit: an independent frame and its dependent substreams.
struct Unit {
    samples: usize,
    joc: Option<crate::joc::JocFrame>,
    oamd: Option<oamd::ObjectAudioMetadataPayload>,
}

enum Pcm {
    Layout { channels: usize, mask: u32 },
    Samples(Vec<f32>),
}

pub struct Eac3 {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    pcm: Receiver<Pcm>,
    buffer: Vec<u8>,
    units: VecDeque<Unit>,
    current: Option<Unit>,
    layout: Option<(usize, u32)>,
    pcm_buf: VecDeque<f32>,
    upmix: Upmix,
    scene: Scene,
    atmos: Option<bool>,
    samples: u64,
    /// Bed channel IDs of the core channels (no JOC), None = LFE.
    core_beds: Vec<Option<u32>>,
}

/// FFmpeg's WAV channel mask bits, in channel order: Dolby channel ID (None = LFE).
const MASK: [(u32, Option<u32>); 11] = [
    (0x1, Some(1)),
    (0x2, Some(2)),
    (0x4, Some(3)),
    (0x8, None),
    (0x10, Some(7)),
    (0x20, Some(8)),
    (0x100, Some(3)), // back centre: no Dolby bed position; nearest [I]
    (0x200, Some(5)),
    (0x400, Some(6)),
    (0x800, Some(3)),
    (0x20000, Some(3)),
];

/// AC-3 frame size in 16-bit words (ATSC A/52 table 5.18), by fscod and frmsizecod.
fn ac3_frame_words(fscod: usize, code: usize) -> Option<usize> {
    const KBPS: [usize; 19] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
    let kbps = *KBPS.get(code / 2)?;
    Some(match fscod {
        0 => kbps * 2,                                // 48 kHz
        1 => kbps * 1000 * 1536 / 44100 / 16 + (code & 1), // 44.1 kHz
        2 => kbps * 3,                                // 32 kHz
        _ => return None,
    })
}

fn mask_channels(mask: u32) -> Vec<(u32, Option<u32>)> {
    MASK.iter().filter(|(b, _)| mask & b != 0).copied().collect()
}

fn spawn_reader(mut out: std::process::ChildStdout, tx: Sender<Pcm>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        // WAV header: find "fmt " and "data"
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        let (mut channels, mut mask) = (0usize, 0u32);
        loop {
            if out.read_exact(&mut byte).is_err() {
                return;
            }
            head.push(byte[0]);
            if head.len() >= 8 && &head[head.len() - 8..head.len() - 4] == b"data" {
                break;
            }
            if head.len() > 1 << 16 {
                return;
            }
        }
        if let Some(i) = head.windows(4).position(|w| w == b"fmt ") {
            let f = &head[i + 8..];
            channels = u16::from_le_bytes([f[2], f[3]]) as usize;
            let tag = u16::from_le_bytes([f[0], f[1]]);
            mask = if tag == 0xFFFE && f.len() >= 24 {
                u32::from_le_bytes([f[20], f[21], f[22], f[23]])
            } else {
                match channels {
                    6 => 0x60F,
                    8 => 0x63F,
                    2 => 0x3,
                    _ => 0,
                }
            };
        }
        if tx.send(Pcm::Layout { channels, mask }).is_err() {
            return;
        }
        let mut buf = vec![0u8; 1 << 16];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match out.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            let whole = carry.len() / 4 * 4;
            let v: Vec<f32> = carry[..whole].chunks(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            carry.drain(..whole);
            if tx.send(Pcm::Samples(v)).is_err() {
                return;
            }
        }
    })
}

impl Eac3 {
    pub fn new(ffmpeg: &str) -> anyhow::Result<Self> {
        let mut child = Command::new(ffmpeg)
            .args(["-v", "error", "-f", "eac3", "-i", "pipe:0", "-f", "wav", "-acodec", "pcm_f32le", "pipe:1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let (tx, rx) = channel();
        let reader = spawn_reader(child.stdout.take().unwrap(), tx);
        let stdin = child.stdin.take();
        Ok(Self {
            child: Some(child),
            stdin,
            reader: Some(reader),
            pcm: rx,
            buffer: Vec::new(),
            units: VecDeque::new(),
            current: None,
            layout: None,
            pcm_buf: VecDeque::new(),
            upmix: Upmix::new(),
            scene: Scene::default(),
            atmos: None,
            samples: 0,
            core_beds: Vec::new(),
        })
    }

    /// Split the bytes into syncframes; group each independent frame with its dependents.
    fn frames(&mut self) {
        loop {
            let b = &self.buffer;
            let Some(start) = b.windows(2).position(|w| w == [0x0B, 0x77]) else {
                let keep = self.buffer.len().min(1);
                self.buffer.drain(..self.buffer.len() - keep);
                return;
            };
            if start > 0 {
                self.buffer.drain(..start);
                continue;
            }
            if b.len() < 6 {
                return;
            }
            // bsid <= 10: an AC-3 frame (size from frmsizecod; an independent 1536-sample unit,
            // as the core of a 7.1 E-AC-3 stream is); above: E-AC-3 (frmsiz)
            let bsid = b[5] >> 3;
            let (size, strmtyp, blocks) = if bsid <= 10 {
                let (fscod, code) = ((b[4] >> 6) as usize, (b[4] & 0x3F) as usize);
                match ac3_frame_words(fscod, code) {
                    Some(w) => (w * 2, 0, 6),
                    None => (0, 0, 0),
                }
            } else {
                let size = ((((b[2] & 7) as usize) << 8) | b[3] as usize) * 2 + 2;
                let fscod = b[4] >> 6;
                let numblkscod = (b[4] >> 4) & 3;
                (size, b[2] >> 6, if fscod == 3 { 6 } else { [1, 2, 3, 6][numblkscod as usize] })
            };
            if size < 8 {
                self.buffer.drain(..1); // not a real sync word
                continue;
            }
            if self.buffer.len() < size {
                return;
            }
            let frame: Vec<u8> = self.buffer.drain(..size).collect();
            let container = find_container(&frame);
            let (joc, oamd) = match container {
                Some(c) => (c.joc, c.oamd.and_then(|(bytes, offset)| {
                    let mut p = oamd::ObjectAudioMetadataPayload::read(&bytes).ok()?;
                    p.evo_sample_offset = offset as u64;
                    Some(p)
                })),
                None => (None, None),
            };
            if strmtyp != 1 {
                // a new access unit
                if let Some(u) = self.current.take() {
                    self.units.push_back(u);
                }
                self.current = Some(Unit { samples: blocks * 256, joc, oamd });
            } else if let Some(u) = self.current.as_mut() {
                if u.joc.is_none() {
                    u.joc = joc;
                }
                if u.oamd.is_none() {
                    u.oamd = oamd;
                }
            }
        }
    }

    /// Take what the decoder has sent; with `wait`, block for at least one message. Returns
    /// false once the decoder's output has closed.
    fn drain_pcm(&mut self, wait: bool) -> bool {
        loop {
            let msg = if wait {
                match self.pcm.recv() {
                    Ok(m) => Some(m),
                    Err(_) => return false,
                }
            } else {
                match self.pcm.try_recv() {
                    Ok(m) => Some(m),
                    Err(std::sync::mpsc::TryRecvError::Empty) => return true,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return false,
                }
            };
            match msg {
                Some(Pcm::Layout { channels, mask }) => {
                    self.layout = Some((channels, mask));
                    self.core_beds = mask_channels(mask).into_iter().map(|(_, id)| id).collect();
                    let has = |id| self.core_beds.contains(&Some(id));
                    if has(5) && has(6) && !has(7) && !has(8) {
                        for id in self.core_beds.iter_mut().flatten() {
                            if *id == 5 || *id == 6 {
                                *id += 2; // 5.1 surrounds at the rear corners
                            }
                        }
                    }
                }
                Some(Pcm::Samples(v)) => {
                    self.pcm_buf.extend(v);
                    if wait {
                        return true;
                    }
                }
                None => return true,
            }
        }
    }

    /// Emit every access unit whose PCM has arrived.
    fn emit(&mut self, out: &mut dyn FnMut(Block)) {
        let Some((channels, mask)) = self.layout else { return };
        let order = mask_channels(mask);
        while let Some(u) = self.units.front() {
            if self.pcm_buf.len() < u.samples * channels {
                return;
            }
            let u = self.units.pop_front().unwrap();
            let pcm: Vec<f32> = self.pcm_buf.drain(..u.samples * channels).collect();
            let chan = |bit: u32| order.iter().position(|(b, _)| *b == bit);
            let col = |c: usize| -> Vec<f32> { (0..u.samples).map(|s| pcm[s * channels + c]).collect() };
            if self.atmos.is_none() && (u.joc.is_some() || u.oamd.is_some()) {
                self.atmos = Some(true);
            }
            if let Some(p) = &u.oamd {
                self.scene.update(p, self.samples);
            }
            if self.atmos == Some(true) {
                if let Some(j) = &u.joc {
                    self.upmix.frame(j, u.samples / 64);
                }
                // JOC inputs: L R C Ls Rs (Lb Rb); a 5.1 without sides uses its backs
                let side = |s: u32, b: u32| chan(s).or(chan(b));
                let inputs: Vec<Vec<f32>> = [Some(chan(0x1)), Some(chan(0x2)), Some(chan(0x4)), Some(side(0x200, 0x10)), Some(side(0x400, 0x20)), Some(chan(0x10)), Some(chan(0x20))]
                    .into_iter()
                    .map(|c| c.flatten().map(col).unwrap_or_else(|| vec![0.0; u.samples]))
                    .collect();
                let lfe = chan(0x8).map(col).unwrap_or_else(|| vec![0.0; u.samples]);
                let n_obj = self.upmix.objects;
                let mut objects: Vec<Vec<f32>> = vec![Vec::with_capacity(u.samples); n_obj];
                let mut slot_out: Vec<Vec<f32>> = vec![vec![0.0; 64]; n_obj];
                for t in 0..u.samples / 64 {
                    let refs: Vec<&[f32]> = inputs.iter().map(|v| &v[t * 64..t * 64 + 64]).collect();
                    if n_obj > 0 {
                        self.upmix.slot(&refs, &mut slot_out);
                    }
                    for (o, s) in objects.iter_mut().zip(&slot_out) {
                        o.extend_from_slice(s);
                    }
                }
                // OAMD order: beds (the LFE) and objects; JOC objects fill the non-LFE inputs
                let mut channels_out = Vec::with_capacity(self.scene.inputs.len());
                let mut next = 0;
                for input in &self.scene.inputs {
                    if input.kind == Kind::Lfe {
                        channels_out.push(lfe.clone());
                    } else {
                        channels_out.push(objects.get(next).cloned().unwrap_or_else(|| vec![0.0; u.samples]));
                        next += 1;
                    }
                }
                out(Block { start: self.samples, samples: channels_out });
            } else {
                out(Block { start: self.samples, samples: (0..channels).map(col).collect() });
            }
            self.samples += u.samples as u64;
        }
    }
}

impl Feed for Eac3 {
    fn push(&mut self, bytes: &[u8], out: &mut dyn FnMut(Block)) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(bytes);
        }
        self.buffer.extend_from_slice(bytes);
        self.frames();
        self.drain_pcm(false);
        self.emit(out);
    }

    fn end(&mut self, out: &mut dyn FnMut(Block)) {
        if let Some(u) = self.current.take() {
            self.units.push_back(u);
        }
        drop(self.stdin.take()); // EOF to the decoder
        while !self.units.is_empty() {
            let open = self.drain_pcm(true);
            self.emit(out);
            if !open {
                break;
            }
        }
        // Frames the decoder never produced come out as silence, so the length holds.
        if let Some((channels, _)) = self.layout {
            while let Some(u) = self.units.front() {
                let missing = u.samples * channels - self.pcm_buf.len().min(u.samples * channels);
                self.pcm_buf.extend(std::iter::repeat_n(0.0, missing));
                self.emit(out);
            }
        }
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
        if let Some(mut c) = self.child.take() {
            let _ = c.wait();
        }
    }

    fn sources(&mut self, sample: u64) -> Vec<Source> {
        if self.atmos == Some(true) {
            self.scene.advance(sample);
            self.scene
                .inputs
                .iter()
                .map(|i| {
                    let (pos, gain) = i.state(sample);
                    match i.kind {
                        Kind::Lfe => Source::Lfe { gain },
                        _ => Source::Positioned { pos, mode: i.mode, gain },
                    }
                })
                .collect()
        } else {
            self.core_beds
                .iter()
                .map(|id| match id {
                    None => Source::Lfe { gain: 1.0 },
                    Some(id) => Source::Positioned { pos: bed_position(*id).unwrap(), mode: Mode::Mid, gain: 1.0 },
                })
                .collect()
        }
    }
}
