# Test fixtures

`dolby-vision-p5.mkv`: one second of FFmpeg's `testsrc2` (256x144, 10-bit HEVC from x265)
with a Dolby Vision profile 5 RPU on every frame, muxed by mkvmerge, which writes the Dolby
Vision configuration record. The RPU is `assets/tests/profile5.bin` from
[dovi_tool](https://github.com/quietvoid/dovi_tool) (MIT), duplicated to 24 frames with
`dovi_tool editor` and injected with `dovi_tool inject-rpu`. The picture isn't real profile 5
content (IPT), so it shows that the RPU is applied, not what a real title looks like.
