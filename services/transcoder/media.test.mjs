import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  metadata,
  select,
  ffmpegArgs,
  duration,
  manifestReady,
  manifestStart,
  videoCodec,
  withFullDuration,
  withVideoCodec,
} from './media.mjs';
const exec = promisify(execFile);
let dir, media;
before(async () => {
  dir = await mkdtemp(`${tmpdir()}/guest-media-`);
  await writeFile(
    `${dir}/subs.srt`,
    '1\n00:00:01,000 --> 00:00:04,000\nGuest playback\n'
  );
  await writeFile(
    `${dir}/chapters.txt`,
    ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=12000\ntitle=Main\n'
  );
  await exec('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-i',
    `${dir}/subs.srt`,
    '-f',
    'ffmetadata',
    '-i',
    `${dir}/chapters.txt`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:s',
    '-map_metadata',
    '3',
    '-map_chapters',
    '3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '96',
    '-c:a',
    'ac3',
    '-c:s',
    'srt',
    '-t',
    '12',
    `${dir}/source.mkv`,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-of',
    'json',
    `${dir}/source.mkv`,
  ]);
  media = metadata(JSON.parse(stdout));
  // Keyframes only every 10 s, as in many real releases, with one white
  // frame and one beep together at 13 s and 17 s.
  await exec('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    "color=black:size=320x180:rate=24,drawbox=c=white:t=fill:enable='between(t,13,13.04)+between(t,17,17.04)'",
    '-f',
    'lavfi',
    '-i',
    "sine=frequency=1000:sample_rate=48000,volume='if(between(t,13,13.05)+between(t,17,17.05),1,0)':eval=frame",
    '-t',
    '24',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-bf',
    '3',
    '-g',
    '240',
    '-keyint_min',
    '240',
    '-sc_threshold',
    '0',
    '-c:a',
    'eac3',
    `${dir}/longgop.mkv`,
  ]);
});
/** When the white frames play, by the file's own timestamps. */
async function flashesOf(file) {
  const { stderr } = await exec('ffmpeg', [
    '-copyts',
    '-i',
    file,
    '-vf',
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-an',
    '-f',
    'null',
    '-',
  ]);
  const flashes = [];
  let time = 0;
  for (const line of stderr.split('\n')) {
    const at = /pts_time:([\d.]+)/.exec(line);
    if (at) time = Number(at[1]);
    const luma = /YAVG=([\d.]+)/.exec(line);
    if (luma && Number(luma[1]) > 100) flashes.push(time);
  }
  return flashes;
}
/** When the beeps start, by the file's own timestamps. */
async function beepsOf(file) {
  const { stderr } = await exec('ffmpeg', [
    '-copyts',
    '-i',
    file,
    '-af',
    'silencedetect=n=-30dB:d=0.3',
    '-vn',
    '-f',
    'null',
    '-',
  ]);
  return (
    [...stderr.matchAll(/silence_end: ([\d.]+)/g)]
      .map((m) => Number(m[1]))
      // The end of the file reads as the end of a silence too.
      .filter((t) => t < 23)
  );
}
/**
 * A finished DASH output: its manifest, and each stream's init segment and
 * segments joined into one file per stream (0 is the video, 1 the audio).
 */
async function dashOutput(output) {
  const mpd = await readFile(`${output}/manifest.mpd`, 'utf8');
  const files = await (await import('node:fs/promises')).readdir(output);
  const streams = [];
  for (const id of [0, 1]) {
    if (!files.includes(`init-${id}.m4s`)) continue;
    const chunks = files.filter((f) => f.startsWith(`chunk-${id}-`)).sort();
    const path = `${output}/stream-${id}.mp4`;
    await writeFile(
      path,
      Buffer.concat(
        await Promise.all(
          [`init-${id}.m4s`, ...chunks].map((f) => readFile(`${output}/${f}`))
        )
      )
    );
    streams[id] = path;
  }
  return { mpd, streams };
}
const codecOf = async (file) =>
  JSON.parse(
    (
      await exec('ffprobe', [
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        file,
      ])
    ).stdout
  ).streams[0].codec_name;
async function convertLongGop(positionMs) {
  const input = `${dir}/longgop.mkv`,
    output = `${dir}/longgop-${positionMs}`;
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  const command = ffmpegArgs(
    input,
    metadata(JSON.parse(stdout)),
    request({
      positionMs,
      capabilities: { video: true, audio: false, container: false, hdr: false },
    }),
    output
  );
  await mkdir(output);
  await exec('ffmpeg', command.args, { timeout: 60000 });
  return { command, output, ...(await dashOutput(output)) };
}
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
const request = (extra = {}) => ({
  quality: 'original',
  positionMs: 0,
  capabilities: { video: true, audio: true, container: true, hdr: false },
  ...extra,
});
test('HDR: copied where the browser shows it, tone-mapped on the GPU or CPU otherwise', () => {
  const meta = {
    durationMs: 60000,
    tracks: [
      { index: 0, type: 'video', codec: 'hevc', hdr: true },
      { index: 1, type: 'audio', codec: 'eac3', default: true },
    ],
  };
  const caps = (hdr) => ({
    capabilities: { video: true, audio: false, container: true, hdr },
  });
  const tonemaps = (args) =>
    [
      args.some((a) => a.includes('tonemap_opencl')) && 'opencl',
      args.some((a) => a.includes('tonemap=hable') && a.includes('zscale')) &&
        'cpu',
    ].filter(Boolean);
  // The browser shows it (an HDR display, or it tone-maps): only audio converts.
  const shown = ffmpegArgs('in', meta, request(caps(true)), 'out', 'nvidia');
  assert.equal(shown.policy.mode, 'audio');
  assert.equal(shown.tonemap, null);
  assert.deepEqual(tonemaps(shown.args), []);
  // It doesn't (Firefox on an SDR display): the video converts and tone-maps.
  const gpu = ffmpegArgs('in', meta, request(caps(false)), 'out', 'nvidia');
  assert.equal(gpu.policy.videoReason, "HDR the browser can't show");
  assert.equal(gpu.tonemap, 'gpu');
  assert.deepEqual(tonemaps(gpu.args), ['opencl']);
  // The OpenCL device is set up before the input.
  const device = gpu.args.indexOf('-init_hw_device');
  assert.ok(device >= 0 && device < gpu.args.indexOf('-i'));
  assert.equal(gpu.args[device + 1], 'opencl=ocl');
  assert.ok(gpu.args.includes('h264_nvenc'));
  // The fallback keeps NVENC and tone-maps on the CPU.
  const fallback = ffmpegArgs(
    'in',
    meta,
    request(caps(false)),
    'out',
    'nvidia',
    {
      tonemap: 'cpu',
    }
  );
  assert.equal(fallback.tonemap, 'cpu');
  assert.deepEqual(tonemaps(fallback.args), ['cpu']);
  assert.ok(!fallback.args.includes('-init_hw_device'));
  assert.ok(fallback.args.includes('h264_nvenc'));
  // Other encoders tone-map on the CPU.
  for (const encoder of ['cpu', 'vaapi']) {
    const other = ffmpegArgs('in', meta, request(caps(false)), 'out', encoder);
    assert.deepEqual(tonemaps(other.args), ['cpu'], encoder);
    assert.ok(!other.args.includes('-init_hw_device'), encoder);
  }
  // SDR video never tone-maps.
  const sdr = ffmpegArgs(
    'in',
    { ...meta, tracks: [{ ...meta.tracks[0], hdr: false }, meta.tracks[1]] },
    request({ ...caps(false), force: true }),
    'out',
    'nvidia'
  );
  assert.equal(sdr.tonemap, null);
  assert.deepEqual(tonemaps(sdr.args), []);
});
test('select explains why each stream is converted', () => {
  const meta = {
    durationMs: 60000,
    tracks: [
      { index: 0, type: 'video', codec: 'h264' },
      { index: 1, type: 'audio', codec: 'eac3', default: true },
    ],
  };
  const caps = { video: true, audio: false, container: false, hdr: false };
  const original = select(meta, { quality: 'original', capabilities: caps });
  assert.equal(original.mode, 'audio');
  assert.equal(original.videoReason, null);
  assert.equal(original.audioReason, "browser can't decode the audio");
  const scaled = select(meta, { quality: '720p', capabilities: caps });
  assert.equal(scaled.mode, 'video');
  assert.equal(scaled.videoReason, 'quality 720p');
  const retry = select(meta, {
    quality: 'original',
    force: true,
    capabilities: caps,
  });
  assert.equal(retry.videoReason, 'retry after failed playback');
  const unsupported = select(meta, {
    quality: 'original',
    capabilities: { ...caps, video: false },
  });
  assert.equal(unsupported.videoReason, "browser can't decode the video");
});
test('duration falls back to stream durations and Matroska tags', () => {
  assert.equal(duration({ format: { duration: '12.5' } }), 12500);
  assert.equal(
    duration({
      format: {},
      streams: [
        { duration: '10.0' },
        { tags: { DURATION: '01:02:03.500000000' } },
      ],
    }),
    3723500
  );
  assert.equal(duration({ format: { duration: 'N/A' }, streams: [{}] }), 0);
});
test('probe retains chapter timestamps and track choices', () => {
  assert.deepEqual(
    media.chapters.map((c) => c.title),
    ['Opening', 'Main']
  );
  assert.equal(media.chapters[1].startMs, 4000);
  assert.deepEqual(
    media.tracks.map((t) => t.type),
    ['video', 'audio', 'subtitle']
  );
});
test('conversion policy chooses direct, remux, audio, video and burn-in', () => {
  assert.equal(select(media, request()).mode, 'direct');
  assert.equal(
    select(
      media,
      request({ capabilities: { video: true, audio: true, container: false } })
    ).mode,
    'remux'
  );
  assert.equal(
    select(
      media,
      request({ capabilities: { video: true, audio: false, container: false } })
    ).mode,
    'audio'
  );
  assert.equal(select(media, request({ force: true })).mode, 'video');
  assert.equal(
    select(
      {
        ...media,
        tracks: media.tracks.map((t) =>
          t.type === 'subtitle' ? { ...t, codec: 'hdmv_pgs_subtitle' } : t
        ),
      },
      request({ subtitle: 2 })
    ).burn,
    true
  );
  assert.throws(() => select(media, request({ audio: 99 })), /Unknown track/);
});
for (const [name, options] of [
  [
    'remux',
    request({ capabilities: { video: true, audio: true, container: false } }),
  ],
  [
    'audio conversion',
    request({ capabilities: { video: true, audio: false, container: false } }),
  ],
  ['video conversion', request({ force: true, quality: '720p' })],
  ['seek generation', request({ force: true, positionMs: 7000 })],
])
  test(`real FFmpeg: ${name}`, async () => {
    const output = `${dir}/${name.replaceAll(' ', '-')}`;
    await mkdir(output);
    const command = ffmpegArgs(`${dir}/source.mkv`, media, options, output);
    await exec('ffmpeg', command.args, { timeout: 30000 });
    const { mpd, streams } = await dashOutput(output);
    // Finished: the manifest is no longer live.
    assert.match(mpd, /type="static"/);
    assert.ok(manifestReady(mpd));
    // Video and audio, each in its own stream.
    assert.equal(await codecOf(streams[0]), 'h264');
    if (name === 'audio conversion')
      assert.equal(await codecOf(streams[1]), 'aac');
    if (name === 'seek generation') {
      assert.equal(command.offsetMs, 4000);
      // Converted video starts exactly at the seek.
      const start = manifestStart(mpd);
      assert.ok(Math.abs(start - 4) < 0.1, `start ${start}`);
    }
  });

test('real FFmpeg: styled subtitle burn-in', async () => {
  const input = `${dir}/styled.mkv`,
    output = `${dir}/styled-output`;
  await exec('ffmpeg', [
    '-v',
    'error',
    '-i',
    `${dir}/source.mkv`,
    '-map',
    '0',
    '-c',
    'copy',
    '-c:s',
    'ass',
    input,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  const meta = metadata(JSON.parse(stdout));
  await mkdir(output);
  const command = ffmpegArgs(input, meta, request({ subtitle: 2 }), output);
  await exec('ffmpeg', command.args, { timeout: 30000 });
  assert.match((await dashOutput(output)).mpd, /type="static"/);
  assert.equal(command.policy.mode, 'video');
});

test('real FFmpeg: HDR to SDR', async () => {
  const input = `${dir}/hdr.mkv`,
    output = `${dir}/sdr`;
  await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=128x72:rate=24',
      '-t',
      '1',
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p10le',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      '-x265-params',
      'pools=1:frame-threads=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      '-threads',
      '1',
      input,
    ],
    { timeout: 30000 }
  );
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  const meta = metadata(JSON.parse(stdout));
  assert.equal(meta.tracks[0].hdr, true);
  await mkdir(output);
  await exec(
    'ffmpeg',
    ffmpegArgs(
      input,
      meta,
      request({
        capabilities: {
          video: false,
          audio: true,
          container: false,
          hdr: false,
        },
      }),
      output
    ).args,
    { timeout: 30000 }
  );
  assert.equal(await codecOf((await dashOutput(output)).streams[0]), 'h264');
});

test('real FFmpeg: copied video and converted audio stay in step after a seek', async () => {
  // 15 s is 5 s past the keyframe at 10 s: the video starts there, the
  // converted audio at the seek (12 s, floored to 4 s).
  const { command, output, mpd, streams } = await convertLongGop(15000);
  assert.equal(command.policy.mode, 'audio');
  // Browsers (MSE) apply a single edit at most. A stream's start must be in
  // its fragments' timestamps, as the manifest says, not an empty edit,
  // which they skip: that played the audio up to a keyframe interval early.
  for (const id of [0, 1]) {
    const trace = await exec('ffprobe', [
      '-v',
      'trace',
      '-i',
      `${output}/init-${id}.m4s`,
    ]);
    assert.doesNotMatch(trace.stderr, /time=-1 rate/, `stream ${id}`);
  }
  // The stream starts at the keyframe, not where the seek was asked for.
  const start = manifestStart(mpd);
  assert.ok(Math.abs(start - 10) < 0.1, `stream starts at ${start}`);
  // White frames and beeps, at their source times and together.
  const flashes = await flashesOf(streams[0]);
  const beeps = await beepsOf(streams[1]);
  assert.equal(beeps.length, 2, `beeps ${beeps}`);
  for (const [i, at] of [13, 17].entries()) {
    const flash = flashes.find((t) => t >= at - 0.1 && t <= at + 0.2);
    assert.ok(flash != null, `no white frame near ${at}: ${flashes}`);
    assert.ok(Math.abs(beeps[i] - at) < 0.05, `beep at ${beeps[i]}`);
    assert.ok(
      Math.abs(beeps[i] - flash) < 0.06,
      `flash ${flash}, beep ${beeps[i]}`
    );
  }
});

test('real FFmpeg: a stream from the start starts at 0', async () => {
  const { mpd } = await convertLongGop(0);
  const start = manifestStart(mpd);
  assert.ok(start >= 0 && start < 0.1, `stream starts at ${start}`);
});

test('manifest: ready once every stream has a segment', () => {
  const set = (segments) =>
    `<AdaptationSet><SegmentTemplate timescale="1000"><SegmentTimeline>${segments}</SegmentTimeline></SegmentTemplate></AdaptationSet>`;
  assert.equal(manifestReady(''), false);
  assert.equal(
    manifestReady(`<MPD>${set('<S t="5" d="4000" />')}${set('')}</MPD>`),
    false
  );
  const both = `<MPD>${set('<S t="12000" d="4000" />')}${set('<S t="10500" d="4000" />')}</MPD>`;
  assert.equal(manifestReady(both), true);
  // Where both streams have started.
  assert.equal(manifestStart(both), 12);
  assert.equal(manifestStart('<MPD></MPD>'), null);
});

test('manifest: the video gets its full codec string', () => {
  const mpd =
    '<Representation id="0" mimeType="video/mp4" codecs="hvc1" width="1"/><Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2"/>';
  const fixed = withVideoCodec(mpd, 'hvc1.2.4.L153.B0');
  assert.match(fixed, /codecs="hvc1\.2\.4\.L153\.B0"/);
  assert.match(fixed, /codecs="mp4a\.40\.2"/);
  // A full string FFmpeg wrote, or a codec that doesn't match, stays.
  const avc = mpd.replace('codecs="hvc1"', 'codecs="avc1.640028"');
  assert.equal(withVideoCodec(avc, 'avc1.4d401f'), avc);
  assert.equal(withVideoCodec(mpd, 'av01.0.08M.10'), mpd);
  assert.equal(withVideoCodec(mpd, null), mpd);
  // Nothing to build from.
  assert.equal(videoCodec(Buffer.alloc(0)), null);
  assert.equal(videoCodec(Buffer.from('not an init segment')), null);
});

test('real FFmpeg: copied HEVC is tagged hvc1, with its full codec string', async () => {
  const input = `${dir}/hevc.mkv`,
    output = `${dir}/hevc-out`;
  await exec('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '2',
    '-c:v',
    'libx265',
    '-pix_fmt',
    'yuv420p10le',
    '-x265-params',
    'log-level=error',
    '-c:a',
    'eac3',
    input,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  await mkdir(output);
  await exec(
    'ffmpeg',
    ffmpegArgs(
      input,
      metadata(JSON.parse(stdout)),
      request({
        capabilities: {
          video: true,
          audio: false,
          container: false,
          hdr: false,
        },
      }),
      output
    ).args,
    { timeout: 60000 }
  );
  // HEVC Main 10: profile 2, compatible with 2, then tier, level and flags.
  const codec = videoCodec(await readFile(`${output}/init-0.m4s`));
  assert.match(codec, /^hvc1\.2\.4\.L\d+(\.[0-9A-F]{1,2})*$/);
});

test('manifest: a finished one lasts as long as the source', () => {
  // What FFmpeg writes for a job from 40 s of a 60 s file.
  const mpd =
    '<MPD type="static" mediaPresentationDuration="PT20.0S" maxSegmentDuration="PT4S"><Period start="PT0.0S"><S t="480000" d="96000" /></Period></MPD>';
  const full = withFullDuration(mpd, 60_000);
  assert.match(full, /mediaPresentationDuration="PT60\.000S"/);
  assert.match(full, /maxSegmentDuration="PT4S"/);
  // A live manifest has none, and an unknown length leaves it be.
  assert.equal(
    withFullDuration('<MPD type="dynamic">', 60_000),
    '<MPD type="dynamic">'
  );
  assert.equal(withFullDuration(mpd, 0), mpd);
});

test('arguments: NVENC forces IDR keyframes; remote sources reconnect', () => {
  const meta = {
    durationMs: 60000,
    tracks: [
      { index: 0, type: 'video', codec: 'h264' },
      { index: 1, type: 'audio', codec: 'eac3', default: true },
    ],
  };
  const nvenc = ffmpegArgs(
    'http://aio/x',
    meta,
    request({ force: true }),
    'out',
    'nvidia'
  ).args;
  const idr = nvenc.indexOf('-forced-idr');
  assert.ok(idr > 0 && nvenc[idr + 1] === '1');
  assert.ok(nvenc.includes('-reconnect_on_network_error'));
  // The options are for the source: before -i.
  assert.ok(nvenc.indexOf('-reconnect') < nvenc.indexOf('-i'));
  // A local file has nothing to reconnect.
  const local = ffmpegArgs(
    '/tmp/x.mkv',
    meta,
    request({ force: true }),
    'out'
  ).args;
  assert.ok(!local.includes('-reconnect'));
  assert.ok(!local.includes('-forced-idr'));
});

test('real FFmpeg: 5.1 downmixes to stereo without clipping', async () => {
  const input = `${dir}/loud51.mkv`,
    output = `${dir}/loud51-out`;
  // Every channel at full scale, in phase: the worst case for a downmix.
  await exec('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=sin(2*PI*440*t)|sin(2*PI*440*t)|sin(2*PI*440*t)|sin(2*PI*440*t)|sin(2*PI*440*t)|sin(2*PI*440*t):c=5.1:s=48000',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'flac',
    input,
  ]);
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  await mkdir(output);
  const command = ffmpegArgs(
    input,
    metadata(JSON.parse(stdout)),
    request({
      capabilities: { video: true, audio: false, container: false, hdr: false },
    }),
    output
  );
  await exec('ffmpeg', command.args, { timeout: 60000 });
  const { streams } = await dashOutput(output);
  // The float peak: a 16-bit measure (volumedetect) never reads over 0 dB.
  const { stderr } = await exec('ffmpeg', [
    '-i',
    streams[1],
    '-af',
    'astats=measure_perchannel=none',
    '-f',
    'null',
    '-',
  ]);
  const peak = Number(/Peak level dB: (-?[\d.]+)/.exec(stderr)?.[1]);
  // A plain downmix peaks near +8 dBFS; AAC itself overshoots a little.
  assert.ok(peak < 0.5, `peaks at ${peak} dBFS`);
});

test('companion HTTP: auth, source handles, shared jobs, subtitles, capacity and GPU fallback', async () => {
  const { createServer: createHttpServer } = await import('node:http');
  const { createReadStream } = await import('node:fs');
  const { stat } = await import('node:fs/promises');
  const source = createHttpServer(async (req, res) => {
    const file = req.url.includes('styled')
      ? `${dir}/styled.mkv`
      : req.url.includes('longgop')
        ? `${dir}/longgop.mkv`
        : req.url.includes('hevcsrc')
          ? `${dir}/hevcsrc.mkv`
          : `${dir}/source.mkv`;
    const size = (await stat(file)).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0,
      end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/x-matroska',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((resolve, reject) => {
    source.once('error', reject);
    source.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${source.address().port}`;
  process.env.AIOSTREAMS_INTERNAL_URL = origin;
  process.env.TRANSCODER_SECRET = 's'.repeat(32);
  process.env.CACHE_DIR = `${dir}/worker`;
  process.env.TRANSCODER_ENCODER = 'nvidia';
  const { createServer } = await import('./server.mjs');
  const worker = createServer();
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${worker.address().port}`;
  const headers = {
    Authorization: `Bearer ${process.env.TRANSCODER_SECRET}`,
    'Content-Type': 'application/json',
  };
  const call = (path, body) =>
    fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await fetch(base + '/health')).status, 401);
    assert.equal(
      (await call('/probe', { input: 'http://example.invalid/video' })).status,
      400
    );
    const input = `${origin}/party/guest/source/${'a'.repeat(43)}`;
    const probe = await (await call('/probe', { input })).json();
    assert.equal(probe.chapters.length, 2);
    const body = {
      input,
      viewer: 'one'.repeat(8),
      request: request({
        capabilities: { video: true, audio: false, container: false },
      }),
    };
    const first = await call('/prepare', body);
    assert.equal(first.status, 200);
    const job = await first.json();
    assert.equal(job.mode, 'audio');
    const second = await (
      await call('/prepare', { ...body, viewer: 'two'.repeat(8) })
    ).json();
    assert.equal(second.id, job.id);
    assert.match(
      await (await call(`/jobs/${job.id}/manifest.mpd`)).text(),
      /<MPD[\s\S]*codecs="avc1\./
    );
    // Once finished, the manifest lasts as long as the source (12 s).
    for (let i = 0; i < 100; i++) {
      const mpd = await (await call(`/jobs/${job.id}/manifest.mpd`)).text();
      if (mpd.includes('type="static"')) {
        assert.match(mpd, /mediaPresentationDuration="PT12\.\d+S"/);
        break;
      }
      assert.ok(i < 99, 'the job never finished');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // A seek between keyframes reports where the stream really starts: the
    // keyframe, not the floored seek, which put positions seconds off.
    const longInput = `${origin}/party/guest/source/longgop${'b'.repeat(36)}`;
    const long = await call('/prepare', {
      input: longInput,
      viewer: 'long'.repeat(5),
      request: request({
        positionMs: 15000,
        capabilities: { video: true, audio: false, container: false },
      }),
    });
    assert.equal(long.status, 200);
    const longJob = await long.json();
    assert.equal(longJob.mode, 'audio');
    // The player plays the source's own timestamps: no offset.
    assert.equal(longJob.offsetMs, 0);
    assert.ok(
      Math.abs(longJob.startMs - 10000) < 100,
      `start ${longJob.startMs}`
    );
    await call(`/jobs/${longJob.id}/touch`, {
      viewer: 'long'.repeat(5),
      release: true,
    });
    // Copied HEVC: the manifest says which HEVC, as browsers require.
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '4',
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p10le',
      '-x265-params',
      'log-level=error',
      '-c:a',
      'eac3',
      `${dir}/hevcsrc.mkv`,
    ]);
    const hevc = await (
      await call('/prepare', {
        input: `${origin}/party/guest/source/hevcsrc${'c'.repeat(36)}`,
        viewer: 'hevc'.repeat(5),
        request: request({
          capabilities: { video: true, audio: false, container: false },
        }),
      })
    ).json();
    const hevcManifest = await call(`/jobs/${hevc.id}/manifest.mpd`);
    assert.equal(
      hevcManifest.headers.get('content-type'),
      'application/dash+xml'
    );
    assert.match(
      await hevcManifest.text(),
      /mimeType="video\/mp4" codecs="hvc1\.2\.4\.L\d+[.0-9A-F]*"/
    );
    await call(`/jobs/${hevc.id}/touch`, {
      viewer: 'hevc'.repeat(5),
      release: true,
    });
    const subtitle = await call('/subtitle', { input, index: 2 });
    assert.equal(subtitle.status, 200);
    assert.match(await subtitle.text(), /WEBVTT/);
    const gpu = await call('/prepare', {
      input,
      viewer: 'three'.repeat(5),
      request: request({ force: true }),
    });
    assert.equal(gpu.status, 200);
    const gpuJob = await gpu.json();
    const health = await (await call('/health')).json();
    assert.ok(
      health.jobs.every((j) => j.encoder === 'cpu' || j.mode === 'audio')
    );
    const full = await call('/prepare', {
      input,
      viewer: 'four'.repeat(5),
      request: request({ force: true, quality: '720p' }),
    });
    assert.equal(full.status, 503);
    await call(`/jobs/${job.id}/touch`, { viewer: body.viewer, release: true });
    await call(`/jobs/${job.id}/touch`, {
      viewer: 'two'.repeat(8),
      release: true,
    });
    const replacement = await call('/prepare', {
      input,
      viewer: 'four'.repeat(5),
      request: request({ force: true, quality: '720p' }),
    });
    assert.equal(replacement.status, 200);
    await call(`/jobs/${gpuJob.id}/touch`, {
      viewer: 'three'.repeat(5),
      release: true,
    });
    const styled = await call('/prepare', {
      input: `${origin}/party/guest/source/styled`,
      viewer: 'styled'.repeat(5),
      request: request({ subtitle: 2 }),
    });
    assert.equal(styled.status, 200, await styled.text());
  } finally {
    await new Promise((resolve) => worker.close(resolve));
    await new Promise((resolve) => source.close(resolve));
  }
});
