//! The renderer as WebAssembly, for playback in the browser: a session takes a TrueHD or E-AC-3
//! elementary stream in chunks and gives back binaural stereo (48 kHz, interleaved f32), with
//! the input's timing. For E-AC-3 the caller also decodes the core with FFmpeg's decoder
//! (libav.js) and pushes its PCM (`ar_push_pcm`). A plain C ABI, so it needs no bindings crate.

use crate::eac3_in::Eac3;
use crate::input::{Block, Feed, Output, Pipeline};
use crate::loudness::Loudness;
use crate::objects::Modes;
use crate::truehd_in::TrueHd;

enum Input {
    TrueHd(TrueHd),
    Eac3(Eac3),
}

impl Input {
    fn feed(&mut self) -> &mut dyn Feed {
        match self {
            Input::TrueHd(f) => f,
            Input::Eac3(f) => f,
        }
    }
}

pub struct Session {
    input: Input,
    pipeline: Pipeline,
    out: Vec<f32>,
    /// TrueHD: the speaker presentation of the last push (`TrueHd::take_speakers`).
    speakers: Vec<f32>,
}

/// Memory for the caller to write input into.
#[unsafe(no_mangle)]
pub extern "C" fn ar_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub extern "C" fn ar_free(ptr: *mut u8, len: usize) {
    // SAFETY: ptr and len are what ar_alloc returned and was asked for.
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) }
}

/// 0: the stream's render modes (Mid where it has none); 1: every element Near, as Windows does;
/// 2: every element Far.
fn modes(code: u32) -> Modes {
    match code {
        1 => Modes::Windows,
        2 => Modes::Far,
        _ => Modes::Stream,
    }
}

fn session(input: Input) -> *mut Session {
    match Pipeline::new() {
        Ok(pipeline) => Box::into_raw(Box::new(Session { input, pipeline, out: Vec::new(), speakers: Vec::new() })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// A TrueHD session; `modes` as `modes()` reads it.
#[unsafe(no_mangle)]
pub extern "C" fn ar_new(modes_code: u32) -> *mut Session {
    session(Input::TrueHd(TrueHd::new(modes(modes_code))))
}

/// An E-AC-3 session. `windows_loudness`: Windows' RF mode instead of the Reference Player's LINE
/// mode, and the core decoder must be set up to match (`loudness::ffmpeg_args`).
#[unsafe(no_mangle)]
pub extern "C" fn ar_new_eac3(modes_code: u32, windows_loudness: bool) -> *mut Session {
    let loudness = if windows_loudness { Loudness::Windows } else { Loudness::Reference };
    session(Input::Eac3(Eac3::external(modes(modes_code), loudness)))
}

#[unsafe(no_mangle)]
pub extern "C" fn ar_drop(session: *mut Session) {
    if !session.is_null() {
        // SAFETY: from ar_new or ar_new_eac3, and dropped once.
        unsafe { drop(Box::from_raw(session)) }
    }
}

fn interleave(out: &mut Vec<f32>) -> impl FnMut(&[f32], &[f32]) + '_ {
    move |l, r| {
        for (a, b) in l.iter().zip(r) {
            out.push(*a);
            out.push(*b);
        }
    }
}

fn collect(session: &mut Session, run: impl FnOnce(&mut Input, &mut Vec<Block>)) -> usize {
    let Session { input, pipeline, out, .. } = session;
    out.clear();
    if let Some(s) = pipeline.snapshots.as_mut() {
        s.data.clear();
    }
    let mut blocks = Vec::new();
    run(input, &mut blocks);
    for b in blocks {
        pipeline.take(input.feed(), b, &mut interleave(out));
    }
    out.len() / 2
}

/// Render for two built-in speakers instead of headphones (Dolby Atmos for built-in speakers),
/// from the next push on; before the first push, for a stream rendered that way throughout.
#[unsafe(no_mangle)]
pub extern "C" fn ar_render_for_speakers(session: *mut Session) -> bool {
    // SAFETY: a live session.
    let session = unsafe { &mut *session };
    match Pipeline::with_output(Output::Speakers) {
        Ok(p) => {
            session.pipeline = p;
            session.input.feed().set_speakers(true);
            true
        }
        Err(_) => false,
    }
}

/// Push `len` bytes of the stream; returns how many stereo frames `ar_output` now holds.
#[unsafe(no_mangle)]
pub extern "C" fn ar_push(session: *mut Session, ptr: *const u8, len: usize) -> usize {
    // SAFETY: a live session, and len readable bytes at ptr.
    let (session, bytes) = unsafe { (&mut *session, std::slice::from_raw_parts(ptr, len)) };
    let frames = collect(session, |input, blocks| input.feed().push(bytes, &mut |b| blocks.push(b)));
    session.speakers = match &mut session.input {
        Input::TrueHd(f) => f.take_speakers(),
        Input::Eac3(_) => Vec::new(),
    };
    frames
}

/// TrueHD: the last push's speaker presentation, FFmpeg's decode of it (the highest presentation
/// up to 8 channels, no dialnorm), for playing to speakers instead of the binaural render: how
/// many f32 `ar_speakers` holds, `ar_speaker_channels` interleaved, one sample for each sample
/// the push took (the binaural output's sample k is the stream's sample k, as for these).
#[unsafe(no_mangle)]
pub extern "C" fn ar_speakers_len(session: *mut Session) -> usize {
    // SAFETY: a live session.
    unsafe { (*session).speakers.len() }
}

#[unsafe(no_mangle)]
pub extern "C" fn ar_speakers(session: *mut Session) -> *const f32 {
    // SAFETY: a live session.
    unsafe { (*session).speakers.as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn ar_speaker_channels(session: *mut Session) -> usize {
    // SAFETY: a live session.
    match unsafe { &(*session).input } {
        Input::TrueHd(f) => f.speaker_channels(),
        Input::Eac3(_) => 0,
    }
}

/// FFmpeg's channel mask of the speaker presentation (as f64: up to bit 35).
#[unsafe(no_mangle)]
pub extern "C" fn ar_speaker_mask(session: *mut Session) -> f64 {
    // SAFETY: a live session.
    match unsafe { &(*session).input } {
        Input::TrueHd(f) => f.speaker_mask as f64,
        Input::Eac3(_) => 0.0,
    }
}

/// E-AC-3 only: the core decoder's output for the bytes pushed so far, in order — `len` f32 at
/// `ptr`, interleaved in FFmpeg's (WAV) channel order, `channels` channels with channel mask
/// `mask`. Returns how many stereo frames `ar_output` now holds (0 for a TrueHD session).
#[unsafe(no_mangle)]
pub extern "C" fn ar_push_pcm(session: *mut Session, ptr: *const f32, len: usize, channels: usize, mask: u32) -> usize {
    // SAFETY: a live session, and len readable f32 at ptr.
    let (session, samples) = unsafe { (&mut *session, std::slice::from_raw_parts(ptr, len)) };
    collect(session, |input, blocks| {
        if let Input::Eac3(f) = input {
            f.push_pcm(channels, mask, samples, &mut |b| blocks.push(b));
        }
    })
}

/// The end of the stream: flushes what's buffered; returns the frames `ar_output` holds.
#[unsafe(no_mangle)]
pub extern "C" fn ar_finish(session: *mut Session) -> usize {
    // SAFETY: a live session.
    let session = unsafe { &mut *session };
    collect(session, |input, blocks| input.feed().end(&mut |b| blocks.push(b)));
    let Session { input, pipeline, out, .. } = session;
    pipeline.finish(input.feed(), &mut interleave(out));
    out.len() / 2
}

/// Keeps snapshots of the scene as rendered, for a debug view: each push or finish call then
/// leaves those taken in it at `ar_debug_data` (`input::Snapshots` has the layout).
#[unsafe(no_mangle)]
pub extern "C" fn ar_debug(session: *mut Session, on: bool) {
    // SAFETY: a live session.
    unsafe { (*session).pipeline.debug(on) }
}

/// For the debug view: render the `len` inputs listed at `ptr` (u32 indices in the snapshots'
/// order) as silence; `len` 0 renders them all.
#[unsafe(no_mangle)]
pub extern "C" fn ar_disable(session: *mut Session, ptr: *const u32, len: usize) {
    let list: Vec<usize> = if len == 0 {
        Vec::new()
    } else {
        // SAFETY: the caller's `len` u32s at `ptr`.
        unsafe { std::slice::from_raw_parts(ptr, len) }.iter().map(|&i| i as usize).collect()
    };
    // SAFETY: a live session.
    unsafe { (*session).pipeline.disable(&list) }
}

/// How many f64 `ar_debug_data` holds.
#[unsafe(no_mangle)]
pub extern "C" fn ar_debug_len(session: *mut Session) -> usize {
    // SAFETY: a live session.
    unsafe { (*session).pipeline.snapshots.as_ref().map_or(0, |s| s.data.len()) }
}

#[unsafe(no_mangle)]
pub extern "C" fn ar_debug_data(session: *mut Session) -> *const f64 {
    // SAFETY: a live session.
    unsafe { (*session).pipeline.snapshots.as_ref().map_or(std::ptr::null(), |s| s.data.as_ptr()) }
}

/// The last call's output: interleaved stereo f32.
#[unsafe(no_mangle)]
pub extern "C" fn ar_output(session: *mut Session) -> *const f32 {
    // SAFETY: a live session.
    unsafe { (*session).out.as_ptr() }
}
