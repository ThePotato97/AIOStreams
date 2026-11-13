# Test fixtures

- `p5-init.m4s`, `p5-segment.m4s`: the transcoder's `services/transcoder/fixtures/dolby-vision-p5.mkv`
  (dovi_tool's profile 5 test RPU on FFmpeg's `testsrc2`) cut to its first 4 frames and remuxed by
  FFmpeg into DASH with `-c copy -strict experimental` (which writes the `dvcC` box, as the
  transcoder's TrueHD copy does): its init segment and one media segment. 12288 Hz timescale, an edit
  list moving presentation 1020 ticks earlier, frames at 0, 0.208, 0.125, 0.042 s in decoding order.
- `fel_orig.bin`: `assets/tests/fel_orig.bin` from [dovi_tool](https://github.com/quietvoid/dovi_tool)
  (MIT): a profile 7 FEL RPU with MMR reshaping, as dovi_tool writes RPUs (a start code, then the RPU
  without its NAL header). The test's expected values are the `dolby_vision` crate's (3.4.0) for it.
