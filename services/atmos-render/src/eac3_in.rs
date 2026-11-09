//! E-AC-3 input. The core is decoded by FFmpeg's decoder (it handles AHT): natively an FFmpeg
//! child, fed the same bytes the renderer reads, its PCM taken back as WAV for the channel layout;
//! in the browser libav.js (the same decoder, with the same options), whose PCM the caller pushes
//! in (`push_pcm`). Each access unit's EMDF (OAMD and JOC) comes from the bitstream; JOC rebuilds
//! the objects from the core. Without JOC the core channels render as beds at Dolby's positions.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use crate::channels::{self, Static, WAV};
use crate::input::{Block, Feed};
use crate::joc::{Upmix, find_container};
use crate::loudness::{self, Loudness};
use crate::objects::{Kind, Modes, Scene};
use crate::render::Source;

/// One access unit: an independent frame and its dependent substreams.
struct Unit {
    samples: usize,
    /// The access unit's first frame's compr word (None: compre = 0).
    compr: Option<i8>,
    joc: Option<crate::joc::JocFrame>,
    oamd: Option<oamd::ObjectAudioMetadataPayload>,
}

enum Pcm {
    Layout { channels: usize, mask: u32 },
    Samples(Vec<f32>),
}

/// The FFmpeg child decoding the core.
struct Decoder {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    pcm: Receiver<Pcm>,
}

pub struct Eac3 {
    /// None: the caller decodes the core and pushes its PCM (`push_pcm`).
    decoder: Option<Decoder>,
    buffer: Vec<u8>,
    units: VecDeque<Unit>,
    current: Option<Unit>,
    layout: Option<(usize, u32)>,
    pcm_buf: VecDeque<f32>,
    upmix: Upmix,
    scene: Scene,
    loudness: Loudness,
    atmos: Option<bool>,
    samples: u64,
    /// Bed channel IDs of the core channels (no JOC), None = LFE.
    core_beds: Vec<Static>,
}


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

/// The WAV mask bits present, in channel order.
fn mask_bits(mask: u32) -> Vec<u32> {
    WAV.iter().map(|&(b, _)| b).filter(|b| mask & b != 0).collect()
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
    /// `ffmpeg` decodes the core, with DRC and dialnorm set up for `loudness` (`loudness.rs`).
    pub fn new(ffmpeg: &str, modes: Modes, loudness: Loudness) -> anyhow::Result<Self> {
        let mut child = Command::new(ffmpeg)
            .args(["-v", "error"])
            .args(loudness::ffmpeg_args(loudness))
            .args(["-f", "eac3", "-i", "pipe:0", "-f", "wav", "-acodec", "pcm_f32le", "pipe:1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let (tx, rx) = channel();
        let reader = spawn_reader(child.stdout.take().unwrap(), tx);
        let stdin = child.stdin.take();
        let mut feed = Self::external(modes, loudness);
        feed.decoder = Some(Decoder { child: Some(child), stdin, reader: Some(reader), pcm: rx });
        Ok(feed)
    }

    /// A feed whose core PCM the caller decodes with FFmpeg's E-AC-3 decoder, set up as
    /// `loudness::ffmpeg_args(loudness)` says, and pushes in with `push_pcm`.
    pub fn external(modes: Modes, loudness: Loudness) -> Self {
        Self {
            decoder: None,
            buffer: Vec::new(),
            units: VecDeque::new(),
            current: None,
            layout: None,
            pcm_buf: VecDeque::new(),
            upmix: Upmix::new(),
            scene: Scene::new(modes),
            loudness,
            atmos: None,
            samples: 0,
            core_beds: Vec::new(),
        }
    }

    fn set_layout(&mut self, channels: usize, mask: u32) {
        if self.layout != Some((channels, mask)) {
            self.layout = Some((channels, mask));
            self.core_beds = channels::routed(channels::wav_mask(mask), self.scene.modes, self.scene.speakers);
        }
    }

    /// The decoder's output for the bytes pushed so far, in order: interleaved f32 in WAV channel
    /// order (FFmpeg's), `channels` channels with the WAV/FFmpeg channel mask `mask`.
    pub fn push_pcm(&mut self, channels: usize, mask: u32, samples: &[f32], out: &mut dyn FnMut(Block)) {
        self.set_layout(channels, mask);
        self.pcm_buf.extend(samples);
        self.emit(out);
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
                self.current = Some(Unit { samples: blocks * 256, compr: loudness::frame_compr(&frame), joc, oamd });
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
            let Some(decoder) = self.decoder.as_ref() else { return false };
            let msg = if wait {
                match decoder.pcm.recv() {
                    Ok(m) => Some(m),
                    Err(_) => return false,
                }
            } else {
                match decoder.pcm.try_recv() {
                    Ok(m) => Some(m),
                    Err(std::sync::mpsc::TryRecvError::Empty) => return true,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return false,
                }
            };
            match msg {
                Some(Pcm::Layout { channels, mask }) => self.set_layout(channels, mask),
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
        let order = mask_bits(mask);
        while let Some(u) = self.units.front() {
            if self.pcm_buf.len() < u.samples * channels {
                return;
            }
            let u = self.units.pop_front().unwrap();
            // Windows' RF offset on frames carrying compr; the decoder's clip to +/-1 (the JOC
            // path clips its own output).
            let factor = loudness::frame_factor(self.loudness, u.compr);
            let pcm: Vec<f32> = self.pcm_buf.drain(..u.samples * channels).map(|v| v * factor).collect();
            let chan = |bit: u32| order.iter().position(|b| *b == bit);
            let col = |c: usize| -> Vec<f32> { (0..u.samples).map(|s| pcm[s * channels + c]).collect() };
            // Windows' decoder runs JOC only on a 3/2 core (L, R, C and a surround pair).
            let side = |s: u32, b: u32| chan(s).or(chan(b));
            let core_32 = [chan(0x1), chan(0x2), chan(0x4), side(0x200, 0x10), side(0x400, 0x20)].iter().all(Option::is_some);
            if self.atmos.is_none() && core_32 && (u.joc.is_some() || u.oamd.is_some()) {
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
                let clip = |c: usize| col(c).into_iter().map(|v| v.clamp(-1.0, 1.0)).collect();
                out(Block { start: self.samples, samples: (0..channels).map(clip).collect() });
            }
            self.samples += u.samples as u64;
        }
    }
}

impl Feed for Eac3 {
    fn set_speakers(&mut self, on: bool) {
        self.scene.speakers = on;
    }

    fn push(&mut self, bytes: &[u8], out: &mut dyn FnMut(Block)) {
        if let Some(stdin) = self.decoder.as_mut().and_then(|d| d.stdin.as_mut()) {
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
        if let Some(d) = self.decoder.as_mut() {
            drop(d.stdin.take()); // EOF to the decoder
        }
        while self.decoder.is_some() && !self.units.is_empty() {
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
        if let Some(mut d) = self.decoder.take() {
            if let Some(r) = d.reader.take() {
                let _ = r.join();
            }
            if let Some(mut c) = d.child.take() {
                let _ = c.wait();
            }
        }
    }

    fn elements(&self) -> Vec<crate::input::Element> {
        if self.atmos == Some(true) {
            self.scene.elements()
        } else {
            self.core_beds.iter().map(|&s| channels::element(s)).collect()
        }
    }

    fn sources(&mut self, sample: u64) -> Vec<Source> {
        if self.atmos == Some(true) {
            self.scene.advance(sample);
            self.scene.sources()
        } else {
            self.core_beds.iter().map(|&s| channels::source(s, self.scene.modes)).collect()
        }
    }
}
