//! atmos-render: reads a raw Dolby TrueHD or E-AC-3 elementary stream on stdin and
//! writes binaural stereo, 48 kHz 32-bit float little-endian interleaved, on stdout; the output
//! has the input's length and timing.
//!
//!   ffmpeg -i film.mkv -map 0:a:0 -c copy -f truehd - | atmos-render --format truehd > out.f32

use std::io::{BufWriter, Read, Write};

use anyhow::{Result, bail};
use atmos_render::eac3_in::Eac3;
use atmos_render::input::{Feed, Pipeline};
use atmos_render::truehd_in::TrueHd;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let format = args.iter().position(|a| a == "--format").and_then(|i| args.get(i + 1)).map(String::as_str);
    let mut feed: Box<dyn Feed> = match format {
        Some("truehd") | None => Box::new(TrueHd::new()),
        Some("eac3") => {
            let ffmpeg = args.iter().position(|a| a == "--ffmpeg").and_then(|i| args.get(i + 1)).map(String::as_str);
            Box::new(Eac3::new(ffmpeg.unwrap_or("ffmpeg"))?)
        }
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
