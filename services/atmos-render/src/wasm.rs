//! The renderer as WebAssembly, for playback in the browser: a session takes a TrueHD
//! elementary stream in chunks and gives back binaural stereo (48 kHz, interleaved f32), with
//! the input's timing. A plain C ABI, so it needs no bindings crate.

use crate::input::{Feed, Pipeline};
use crate::objects::Modes;
use crate::truehd_in::TrueHd;

pub struct Session {
    feed: TrueHd,
    pipeline: Pipeline,
    out: Vec<f32>,
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

/// A session; `windows_modes` renders every element Near, as Windows does.
#[unsafe(no_mangle)]
pub extern "C" fn ar_new(windows_modes: bool) -> *mut Session {
    let modes = if windows_modes { Modes::Windows } else { Modes::Stream };
    match Pipeline::new() {
        Ok(pipeline) => Box::into_raw(Box::new(Session { feed: TrueHd::new(modes), pipeline, out: Vec::new() })),
        Err(_) => std::ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ar_drop(session: *mut Session) {
    if !session.is_null() {
        // SAFETY: from ar_new, and dropped once.
        unsafe { drop(Box::from_raw(session)) }
    }
}

fn collect(session: &mut Session, run: impl FnOnce(&mut TrueHd, &mut Vec<crate::input::Block>)) -> usize {
    let Session { feed, pipeline, out } = session;
    out.clear();
    let mut blocks = Vec::new();
    run(feed, &mut blocks);
    for b in blocks {
        pipeline.take(feed, b, &mut |l, r| {
            for (a, b) in l.iter().zip(r) {
                out.push(*a);
                out.push(*b);
            }
        });
    }
    out.len() / 2
}

/// Push `len` bytes of the stream; returns how many stereo frames `ar_output` now holds.
#[unsafe(no_mangle)]
pub extern "C" fn ar_push(session: *mut Session, ptr: *const u8, len: usize) -> usize {
    // SAFETY: a live session, and len readable bytes at ptr.
    let (session, bytes) = unsafe { (&mut *session, std::slice::from_raw_parts(ptr, len)) };
    collect(session, |feed, blocks| feed.push(bytes, &mut |b| blocks.push(b)))
}

/// The end of the stream: flushes what's buffered; returns the frames `ar_output` holds.
#[unsafe(no_mangle)]
pub extern "C" fn ar_finish(session: *mut Session) -> usize {
    // SAFETY: a live session.
    let session = unsafe { &mut *session };
    let frames = collect(session, |feed, blocks| feed.end(&mut |b| blocks.push(b)));
    let Session { feed, pipeline, out } = session;
    pipeline.finish(feed, &mut |l, r| {
        for (a, b) in l.iter().zip(r) {
            out.push(*a);
            out.push(*b);
        }
    });
    let _ = frames;
    out.len() / 2
}

/// The last call's output: interleaved stereo f32.
#[unsafe(no_mangle)]
pub extern "C" fn ar_output(session: *mut Session) -> *const f32 {
    // SAFETY: a live session.
    unsafe { (*session).out.as_ptr() }
}
