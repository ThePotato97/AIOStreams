//! atmos-render: reads a raw Dolby TrueHD or E-AC-3 elementary stream on stdin and
//! writes binaural stereo, 48 kHz 32-bit float little-endian interleaved, on stdout; the output
//! has the input's length and timing.
//!
//!   ffmpeg -i film.mkv -map 0:a:0 -c copy -f truehd - | atmos-render --format truehd > out.f32
//!
//! `--modes stream` (default) renders each element in the stream's own headphone mode (Off,
//! Near, Mid, Far; Mid where it has none), as Dolby's Reference Player does; `--modes windows`
//! renders everything Near, as Windows does.
//!
//! `--loudness windows` (default) decodes DD+ as Windows does (RF mode), `--loudness reference`
//! as the Reference Player does (LINE mode). TrueHD gets the Reference Player's dialnorm either
//! way (Windows doesn't decode TrueHD).

use std::io::{BufWriter, Read, Write};

use anyhow::{Result, bail};
use atmos_render::eac3_in::Eac3;
use atmos_render::input::{Feed, Pipeline};
use atmos_render::loudness::Loudness;
use atmos_render::objects::Modes;
use atmos_render::truehd_in::TrueHd;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str);
    let modes = match value("--modes") {
        Some("stream") | None => Modes::Stream,
        Some("windows") => Modes::Windows,
        Some(other) => bail!("unsupported --modes {other} (stream or windows)"),
    };
    let loudness = match value("--loudness") {
        Some("windows") | None => Loudness::Windows,
        Some("reference") => Loudness::Reference,
        Some(other) => bail!("unsupported --loudness {other} (windows or reference)"),
    };
    let mut feed: Box<dyn Feed> = match value("--format") {
        Some("truehd") | None => Box::new(TrueHd::new(modes)),
        Some("eac3") => Box::new(Eac3::new(value("--ffmpeg").unwrap_or("ffmpeg"), modes, loudness)?),
        Some(other) => bail!("unsupported --format {other}"),
    };
    let mut pipeline = Pipeline::new()?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut out = BufWriter::with_capacity(1 << 16, std::io::stdout().lock());
    let mut buf = vec![0u8; 1 << 16];
    let mut failed: Option<std::io::Error> = None;
    let mut emit = |l: &[f32], r: &[f32]| {
        if failed.is_some() {
            return;
        }
        for (a, b) in l.iter().zip(r) {
            if let Err(e) = out.write_all(&a.to_le_bytes()).and_then(|_| out.write_all(&b.to_le_bytes())) {
                failed = Some(e);
                return;
            }
        }
    };
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let mut blocks = Vec::new();
        feed.push(&buf[..n], &mut |b| blocks.push(b));
        for b in blocks {
            pipeline.take(feed.as_mut(), b, &mut emit);
        }
    }
    let mut blocks = Vec::new();
    feed.end(&mut |b| blocks.push(b));
    for b in blocks {
        pipeline.take(feed.as_mut(), b, &mut emit);
    }
    pipeline.finish(feed.as_mut(), &mut emit);
    drop(emit);
    if let Some(e) = failed {
        // the reader went away (the transcoder stopped): not an error of ours
        if e.kind() == std::io::ErrorKind::BrokenPipe {
            return Ok(());
        }
        return Err(e.into());
    }
    out.flush()?;
    Ok(())
}
