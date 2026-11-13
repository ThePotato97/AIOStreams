import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  metadata,
  playbackSpec,
  modeOf,
  ffmpegArgs,
  duration,
  manifestReady,
  outTimeMs,
  manifestStart,
  subtitleKind,
  videoCodec,
  initLayout,
  withFullDuration,
  withVideoCodec,
  nvdecDecodes,
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
      {
        index: 0,
        type: 'video',
        codec: 'hevc',
        pixelFormat: 'yuv420p10le',
        transfer: 'smpte2084',
        hdr: true,
      },
      { index: 1, type: 'audio', codec: 'eac3', default: true },
    ],
  };
  const caps = (hdr) => ({
    capabilities: { video: true, audio: false, container: true, hdr },
  });
  const vf = (args) => args[args.indexOf('-vf') + 1] ?? '';
  const tonemaps = (args) =>
    [
      vf(args).includes('tonemap_cuda') &&
        !vf(args).includes('hwupload') &&
        'cuda',
      vf(args).includes('hwupload,tonemap_cuda') && 'upload',
      vf(args).includes('tonemapx=tonemap=hable') && 'cpu',
    ].filter(Boolean);
  // The browser shows it (an HDR display, or it tone-maps): only audio converts.
  const shown = ffmpegArgs('in', meta, request(caps(true)), 'out', 'nvidia');
  assert.equal(modeOf(shown.spec), 'audio');
  assert.equal(shown.tonemap, null);
  assert.equal(shown.decode, null);
  assert.deepEqual(tonemaps(shown.args), []);
  assert.ok(!shown.args.includes('-hwaccel'));
  // It doesn't (Firefox on an SDR display): decoded, scaled and tone-mapped on
  // the GPU, the frames staying there into NVENC (Jellyfin's chain).
  const gpu = ffmpegArgs('in', meta, request(caps(false)), 'out', 'nvidia');
  assert.equal(gpu.spec.video.reason, "HDR the browser can't show");
  assert.equal(gpu.tonemap, 'gpu');
  assert.equal(gpu.decode, 'gpu');
  assert.deepEqual(tonemaps(gpu.args), ['cuda']);
  const input = gpu.args.indexOf('-i');
  const device = gpu.args.indexOf('-init_hw_device');
  assert.ok(device >= 0 && device < input);
  assert.equal(gpu.args[device + 1], 'cuda=cu:0');
  const hwaccel = gpu.args.indexOf('-hwaccel');
  assert.ok(hwaccel >= 0 && hwaccel < input);
  assert.equal(gpu.args[hwaccel + 1], 'cuda');
  assert.equal(
    gpu.args[gpu.args.indexOf('-hwaccel_output_format') + 1],
    'cuda'
  );
  assert.equal(
    vf(gpu.args),
    "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,scale_cuda=w='trunc(iw/2)*2':h='trunc(ih/2)*2',tonemap_cuda=tonemap=hable:desat=0:t=bt709:m=bt709:p=bt709:range=tv:format=yuv420p"
  );
  assert.ok(gpu.args.includes('h264_nvenc'));
  // A height cap scales on the GPU too.
  const capped = ffmpegArgs(
    'in',
    meta,
    request({ ...caps(false), quality: '1080p' }),
    'out',
    'nvidia'
  );
  assert.match(
    vf(capped.args),
    /scale_cuda=w=-2:h='trunc\(min\(1080,ih\)\/2\)\*2'/
  );
  // HLG keeps its own transfer.
  const hlg = ffmpegArgs(
    'in',
    {
      ...meta,
      tracks: [{ ...meta.tracks[0], transfer: 'arib-std-b67' }, meta.tracks[1]],
    },
    request(caps(false)),
    'out',
    'nvidia'
  );
  assert.match(vf(hlg.args), /color_trc=arib-std-b67/);
  // First fallback: decoded on the CPU, tone-mapped on the GPU.
  const upload = ffmpegArgs('in', meta, request(caps(false)), 'out', 'nvidia', {
    decode: 'cpu',
    tonemap: 'gpu',
  });
  assert.equal(upload.decode, 'cpu');
  assert.equal(upload.tonemap, 'gpu');
  assert.deepEqual(tonemaps(upload.args), ['upload']);
  assert.ok(!upload.args.includes('-hwaccel'));
  assert.equal(
    upload.args[upload.args.indexOf('-init_hw_device') + 1],
    'cuda=cu:0'
  );
  assert.ok(upload.args.includes('h264_nvenc'));
  // Then NVENC with the tone map on the CPU.
  const fallback = ffmpegArgs(
    'in',
    meta,
    request(caps(false)),
    'out',
    'nvidia',
    {
      decode: 'cpu',
      tonemap: 'cpu',
    }
  );
  assert.equal(fallback.tonemap, 'cpu');
  assert.deepEqual(tonemaps(fallback.args), ['cpu']);
  assert.ok(!fallback.args.includes('-init_hw_device'));
  assert.ok(fallback.args.includes('h264_nvenc'));
  // A GPU decode only comes with the GPU tone map.
  const mixed = ffmpegArgs('in', meta, request(caps(false)), 'out', 'nvidia', {
    decode: 'gpu',
    tonemap: 'cpu',
  });
  assert.equal(mixed.decode, 'cpu');
  // Other encoders tone-map on the CPU.
  for (const encoder of ['cpu', 'vaapi']) {
    const other = ffmpegArgs('in', meta, request(caps(false)), 'out', encoder);
    assert.deepEqual(tonemaps(other.args), ['cpu'], encoder);
    assert.ok(!other.args.includes('-init_hw_device'), encoder);
    assert.equal(other.decode, 'cpu', encoder);
  }
  // SDR video never tone-maps, and is still decoded on the GPU.
  const sdr = ffmpegArgs(
    'in',
    {
      ...meta,
      tracks: [
        {
          ...meta.tracks[0],
          hdr: false,
          pixelFormat: 'yuv420p',
          transfer: 'bt709',
        },
        meta.tracks[1],
      ],
    },
    request({ ...caps(false), force: true }),
    'out',
    'nvidia'
  );
  assert.equal(sdr.tonemap, null);
  assert.equal(sdr.decode, 'gpu');
  assert.deepEqual(tonemaps(sdr.args), []);
  assert.equal(
    vf(sdr.args),
    "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale_cuda=w='trunc(iw/2)*2':h='trunc(ih/2)*2':format=yuv420p"
  );
});
test('NVDEC: only the codecs and formats it decodes, never rotated or with burn-in', () => {
  const v = (codec, pixelFormat) => ({ codec, pixelFormat });
  assert.equal(nvdecDecodes(v('h264', 'yuv420p')), true);
  assert.equal(nvdecDecodes(v('h264', 'yuv420p10le')), false);
  assert.equal(nvdecDecodes(v('av1', 'yuv420p10le')), true);
  assert.equal(nvdecDecodes(v('vp9', 'yuv420p12le')), false);
  assert.equal(nvdecDecodes(v('hevc', 'yuv444p12le')), true);
  assert.equal(nvdecDecodes(v('prores', 'yuv422p10le')), false);
  const meta = (extra) => ({
    durationMs: 60000,
    tracks: [
      {
        index: 0,
        type: 'video',
        codec: 'h264',
        pixelFormat: 'yuv420p',
        ...extra,
      },
      { index: 1, type: 'audio', codec: 'aac', default: true },
      { index: 2, type: 'subtitle', codec: 'dvd_subtitle' },
    ],
  });
  const req = (extra) =>
    request({
      force: true,
      capabilities: { video: true, audio: true, container: true },
      ...extra,
    });
  assert.equal(ffmpegArgs('in', meta(), req(), 'out', 'nvidia').decode, 'gpu');
  assert.equal(
    ffmpegArgs(
      'in',
      meta({ pixelFormat: 'yuv420p10le' }),
      req(),
      'out',
      'nvidia'
    ).decode,
    'cpu'
  );
  assert.equal(
    ffmpegArgs('in', meta({ rotation: -90 }), req(), 'out', 'nvidia').decode,
    'cpu'
  );
  assert.equal(
    ffmpegArgs('in', meta(), req({ subtitle: 2 }), 'out', 'nvidia').decode,
    'cpu'
  );
});
test('Dolby Vision profile 5: HDR, never copied, tone-mapped through its RPU', () => {
  const raw = (profile, compatibility, transfer) => ({
    format: { duration: '60' },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        pix_fmt: 'yuv420p10le',
        color_transfer: transfer,
        side_data_list: [
          {
            side_data_type: 'DOVI configuration record',
            dv_profile: profile,
            dv_level: 6,
            dv_bl_signal_compatibility_id: compatibility,
            bl_present_flag: 1,
            el_present_flag: 0,
            rpu_present_flag: 1,
          },
          { side_data_type: 'Display Matrix', rotation: 0 },
        ],
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'eac3',
        disposition: { default: 1 },
      },
    ],
  });
  // Profile 5 carries no colour tags; profile 8.1 has an HDR10 base layer.
  const p5 = metadata(raw(5, 0, undefined)).tracks[0];
  assert.deepEqual(p5.dovi, {
    profile: 5,
    compatibility: 0,
    layers: { base: true, enhancement: false, rpu: true },
  });
  assert.equal(p5.hdr, true);
  assert.equal(p5.rotation, 0);
  const p8 = metadata(raw(8, 1, 'smpte2084')).tracks[0];
  assert.deepEqual(p8.dovi, {
    profile: 8,
    compatibility: 1,
    layers: { base: true, enhancement: false, rpu: true },
  });
  assert.equal(p8.hdr, true);
  const original = request({
    capabilities: { video: true, audio: true, container: true, hdr: true },
  });
  // Profile 8.1 plays as HDR10 where the browser shows HDR; profile 5 can't.
  assert.equal(
    playbackSpec(metadata(raw(8, 1, 'smpte2084')), original).video.where,
    'page-original'
  );
  const p5spec = playbackSpec(metadata(raw(5, 0, undefined)), original);
  assert.equal(p5spec.video.where, 'server-encode');
  assert.equal(p5spec.video.reason, 'Dolby Vision profile 5');
  // Every chain tone-maps it as PQ; the filters apply the RPU by default.
  for (const [encoder, options, filter] of [
    ['nvidia', {}, 'tonemap_cuda'],
    ['nvidia', { decode: 'cpu' }, 'hwupload,tonemap_cuda'],
    ['cpu', {}, 'tonemapx'],
  ]) {
    const { args } = ffmpegArgs(
      'in',
      metadata(raw(5, 0, undefined)),
      original,
      'out',
      encoder,
      options
    );
    const chain = args[args.indexOf('-vf') + 1];
    assert.match(chain, /color_trc=smpte2084/, encoder);
    assert.ok(chain.includes(filter), `${encoder} ${chain}`);
    assert.ok(!chain.includes('apply_dovi=0'), encoder);
  }
});
test('subtitles: burned in only where the browser cannot draw them', () => {
  const meta = {
    durationMs: 60000,
    tracks: [
      { index: 0, type: 'video', codec: 'h264' },
      { index: 1, type: 'audio', codec: 'aac', default: true },
      { index: 2, type: 'subtitle', codec: 'ass' },
      { index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle' },
      { index: 4, type: 'subtitle', codec: 'dvd_subtitle' },
      { index: 5, type: 'subtitle', codec: 'subrip' },
    ],
  };
  const caps = (subtitles) => ({
    capabilities: {
      video: true,
      audio: true,
      container: true,
      hdr: false,
      subtitles,
    },
  });
  const burn = (index, subtitles) =>
    playbackSpec(meta, request({ subtitle: index, ...caps(subtitles) }))
      .subtitle.where === 'server-burn';
  assert.equal(burn(2, ['ass', 'pgs']), false);
  assert.equal(burn(3, ['ass', 'pgs']), false);
  // Without a renderer, or one for something else: burned in.
  assert.equal(burn(2, []), true);
  assert.equal(burn(3, ['ass']), true);
  // VobSub has no renderer at all; text never needs one.
  assert.equal(burn(4, ['ass', 'pgs']), true);
  assert.equal(burn(5, []), false);
  // Not burned, the video is copied.
  assert.equal(
    modeOf(playbackSpec(meta, request({ subtitle: 2, ...caps(['ass']) }))),
    'direct'
  );
  assert.deepEqual(
    [
      'subrip',
      'ass',
      'ssa',
      'hdmv_pgs_subtitle',
      'dvd_subtitle',
      'dvb_subtitle',
      'xsub',
    ].map(subtitleKind),
    // VobSub and DVB are named, though the page doesn't draw them yet (burned in, as before).
    ['text', 'ass', 'ass', 'pgs', 'vobsub', 'dvb', null]
  );
});

test('metadata: fonts attached to the file', () => {
  const meta = metadata({
    format: { duration: '10' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      {
        index: 3,
        codec_type: 'attachment',
        tags: {
          filename: 'Gandhi.TTF',
          mimetype: 'application/x-truetype-font',
        },
      },
      {
        index: 4,
        codec_type: 'attachment',
        tags: { filename: 'cover.jpg', mimetype: 'image/jpeg' },
      },
      { index: 5, codec_type: 'attachment', tags: { filename: 'Other.otf' } },
    ],
  });
  assert.deepEqual(meta.fonts, [
    {
      index: 3,
      filename: 'Gandhi.TTF',
      mimetype: 'application/x-truetype-font',
    },
    { index: 5, filename: 'Other.otf', mimetype: 'font/ttf' },
  ]);
});

test('the spec explains why each stream is converted', () => {
  const meta = {
    durationMs: 60000,
    tracks: [
      { index: 0, type: 'video', codec: 'h264' },
      { index: 1, type: 'audio', codec: 'eac3', default: true },
    ],
  };
  const caps = { video: true, audio: false, container: false, hdr: false };
  const original = playbackSpec(meta, {
    quality: 'original',
    capabilities: caps,
  });
  assert.equal(modeOf(original), 'audio');
  assert.equal(original.video.reason, null);
  assert.equal(original.audio.reason, "browser can't decode the audio");
  const scaled = playbackSpec(meta, { quality: '720p', capabilities: caps });
  assert.equal(modeOf(scaled), 'video');
  assert.equal(scaled.video.reason, 'quality 720p');
  assert.equal(scaled.video.encode.scale, 720);
  const retry = playbackSpec(meta, {
    quality: 'original',
    force: true,
    capabilities: caps,
  });
  assert.equal(retry.video.reason, 'retry after failed playback');
  const unsupported = playbackSpec(meta, {
    quality: 'original',
    capabilities: { ...caps, video: false },
  });
  assert.equal(unsupported.video.reason, "browser can't decode the video");
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
  const mode = (r) => modeOf(playbackSpec(media, r));
  assert.equal(mode(request()), 'direct');
  assert.equal(
    mode(
      request({ capabilities: { video: true, audio: true, container: false } })
    ),
    'remux'
  );
  assert.equal(
    mode(
      request({ capabilities: { video: true, audio: false, container: false } })
    ),
    'audio'
  );
  assert.equal(mode(request({ force: true })), 'video');
  assert.equal(
    playbackSpec(
      {
        ...media,
        tracks: media.tracks.map((t) =>
          t.type === 'subtitle' ? { ...t, codec: 'hdmv_pgs_subtitle' } : t
        ),
      },
      request({ subtitle: 2 })
    ).subtitle.where,
    'server-burn'
  );
  assert.throws(
    () => playbackSpec(media, request({ audio: 99 })),
    /Unknown track/
  );
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
  assert.equal(modeOf(command.spec), 'video');
});

test('real FFmpeg: HDR to SDR', async () => {
  const encoded = `${dir}/hdr-encoded.mkv`,
    input = `${dir}/hdr.mkv`,
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
      encoded,
    ],
    { timeout: 30000 }
  );
  // Tagged in the container too: some x265 builds (jellyfin-ffmpeg's) write no colour VUI,
  // and FFmpeg 6.1 sets no container tags on a stream copy, so either alone isn't enough.
  await exec('ffmpeg', [
    '-v',
    'error',
    '-i',
    encoded,
    '-c',
    'copy',
    '-color_primaries',
    'bt2020',
    '-color_trc',
    'smpte2084',
    '-colorspace',
    'bt2020nc',
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

test('real FFmpeg: Dolby Vision profile 5 is tone-mapped through its RPU', async () => {
  const input = new URL('./fixtures/dolby-vision-p5.mkv', import.meta.url)
    .pathname;
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
  assert.deepEqual(meta.tracks[0].dovi, {
    profile: 5,
    compatibility: 0,
    layers: { base: true, enhancement: false, rpu: true },
  });
  assert.equal(meta.tracks[0].hdr, true);
  const { args, spec } = ffmpegArgs(
    input,
    meta,
    request({
      capabilities: { video: true, audio: true, container: true, hdr: true },
    }),
    `${dir}/unused`
  );
  assert.equal(spec.video.where, 'server-encode');
  const chain = args[args.indexOf('-vf') + 1];
  // The CPU chain's first frame, with the RPU applied and without: they differ
  // only if the RPU reaches the tone map through the filters before it.
  const frame = async (vf) =>
    (
      await exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          vf,
          '-f',
          'rawvideo',
          '-',
        ],
        { encoding: 'buffer', maxBuffer: 1 << 24 }
      )
    ).stdout;
  const applied = await frame(chain);
  const ignored = await frame(
    chain.replace('tonemapx=', 'tonemapx=apply_dovi=0:')
  );
  assert.equal(applied.length, ignored.length);
  let difference = 0;
  for (let i = 0; i < applied.length; i++)
    difference += Math.abs(applied[i] - ignored[i]);
  assert.ok(
    difference / applied.length > 10,
    String(difference / applied.length)
  );
});

test('real FFmpeg: copied video and converted audio stay in step after a seek', async () => {
  // 15 s is 5 s past the keyframe at 10 s: the video starts there, the
  // converted audio at the seek (12 s, floored to 4 s).
  const { command, output, mpd, streams } = await convertLongGop(15000);
  assert.equal(modeOf(command.spec), 'audio');
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
  // FFmpeg 8.1 leaves copied HEVC's codecs empty: filled in.
  const empty = mpd.replace('codecs="hvc1"', 'codecs=""');
  assert.match(
    withVideoCodec(empty, 'hvc1.2.4.L153.B0'),
    /mimeType="video\/mp4" codecs="hvc1\.2\.4\.L153\.B0"/
  );
  // Nothing to build from.
  assert.equal(videoCodec(Buffer.alloc(0)), null);
  assert.equal(videoCodec(Buffer.from('not an init segment')), null);
});

test('an init segment with an empty hvcC gives no codec string, not an error', () => {
  const box = (type, ...content) => {
    const body = Buffer.concat(content);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  // hvc1's 78 bytes of fields, then an hvcC with 2 bytes in it
  const entry = box('hvc1', Buffer.alloc(78), box('hvcC', Buffer.alloc(2)));
  const init = box(
    'moov',
    box(
      'trak',
      box('mdia', box('minf', box('stbl', box('stsd', Buffer.alloc(8), entry))))
    )
  );
  assert.equal(videoCodec(init), null);
  // what the log shows instead
  assert.match(initLayout(init), /stsd:\d+ +hvc1:\d+ +hvcC:2/);
  // a 64-bit size cut short ends the walk
  const cut = Buffer.alloc(12);
  cut.writeUInt32BE(1);
  cut.write('moov', 4, 'latin1');
  assert.equal(videoCodec(cut), null);
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
          : req.url.includes('fonted')
            ? `${dir}/fonted.mkv`
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
  // A viewer's state once it plays: the long poll, asked again until then.
  const playing = async (lease) => {
    let after = -1;
    for (let i = 0; i < 40; i++) {
      const state = await (
        await call(`/viewers/${lease}/state?after=${after}`)
      ).json();
      if (state.ready || state.failure) return state;
      after = state.version;
    }
    assert.fail('never ready');
  };
  const release = (lease) => call(`/viewers/${lease}/release`, {});
  const manifest = (lease) => call(`/viewers/${lease}/manifest.mpd`);
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
    // A video job and an audio job, each its own stream.
    assert.ok(job.jobs.video.id && job.jobs.audio.id);
    const second = await (
      await call('/prepare', { ...body, viewer: 'two'.repeat(8) })
    ).json();
    // The same needs: the same jobs.
    assert.equal(second.jobs.video.id, job.jobs.video.id);
    assert.equal(second.jobs.audio.id, job.jobs.audio.id);
    await playing(job.lease);
    assert.match(
      await (await manifest(job.lease)).text(),
      /<MPD[\s\S]*codecs="avc1\./
    );
    // Once finished, the manifest lasts as long as the source (12 s).
    for (let i = 0; i < 100; i++) {
      const mpd = await (await manifest(job.lease)).text();
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
    const longState = await playing(longJob.lease);
    assert.ok(
      Math.abs(longState.startMs - 10000) < 100,
      `start ${longState.startMs}`
    );
    await release(longJob.lease);
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
    await playing(hevc.lease);
    const hevcManifest = await manifest(hevc.lease);
    assert.equal(
      hevcManifest.headers.get('content-type'),
      'application/dash+xml'
    );
    assert.match(
      await hevcManifest.text(),
      /mimeType="video\/mp4" codecs="hvc1\.2\.4\.L\d+[.0-9A-F]*"/
    );
    await release(hevc.lease);
    // Extracted in the background, once per file: come back until it's written.
    const subtitleBody = { input, file: 'source-file', index: 2 };
    let subtitle = await call('/subtitle', subtitleBody);
    assert.equal(subtitle.status, 425);
    assert.equal(subtitle.headers.get('retry-after'), '5');
    for (let i = 0; i < 100 && subtitle.status === 425; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      subtitle = await call('/subtitle', subtitleBody);
    }
    assert.equal(subtitle.status, 200);
    assert.equal(subtitle.headers.get('x-complete'), '1');
    assert.match(await subtitle.text(), /WEBVTT/);
    // The same file through another link (a new handle): extracted already.
    const again = await call('/subtitle', {
      ...subtitleBody,
      input: `${origin}/party/guest/source/${'e'.repeat(43)}`,
    });
    assert.equal(again.status, 200);
    // NVENC isn't here: the encode falls back to the CPU before its first segment.
    const gpu = await call('/prepare', {
      input,
      viewer: 'three'.repeat(5),
      request: request({ force: true }),
    });
    assert.equal(gpu.status, 200);
    const gpuJob = await gpu.json();
    const gpuState = await playing(gpuJob.lease);
    assert.equal(gpuState.failure, null);
    const health = await (await call('/health')).json();
    const encoded = health.jobs.find((j) => j.id === gpuJob.jobs.video.id);
    assert.equal(encoded.encoder, 'cpu');
    assert.ok(encoded.stages.some((s) => s.fallback === 'encoder'));
    // A copied video never takes the GPU fallback.
    assert.ok(
      health.jobs
        .filter(
          (j) => j.kind === 'video' && j.effective.video.where === 'server-copy'
        )
        .every((j) => !j.stages.some((s) => s.fallback))
    );
    // Two conversions encode video at once: a third waits.
    const encoding = await call('/prepare', {
      input,
      viewer: 'four'.repeat(5),
      request: request({ force: true, quality: '720p' }),
    });
    assert.equal(encoding.status, 200);
    const secondJob = await encoding.json();
    const over = await call('/prepare', {
      input,
      viewer: 'five'.repeat(5),
      request: request({ force: true, quality: '1080p' }),
    });
    assert.equal(over.status, 503);
    assert.equal(over.headers.get('retry-after'), '10');
    const overBody = await over.json();
    assert.equal(overBody.retryAfter, 10);
    assert.equal(overBody.class, 'capacity');
    // Copying the video costs little: it isn't held to that limit.
    const copy = await call('/prepare', {
      input,
      viewer: 'six'.repeat(8),
      request: request({
        capabilities: { video: true, audio: true, container: false },
      }),
    });
    assert.equal(copy.status, 200);
    const copyJob = await copy.json();
    assert.equal(copyJob.mode, 'remux');
    await release(copyJob.lease);
    await release(body.viewer);
    await release('two'.repeat(8));
    // A place is freed: the waiting conversion starts at once.
    await release(secondJob.lease);
    const replacement = await call('/prepare', {
      input,
      viewer: 'five'.repeat(5),
      request: request({ force: true, quality: '1080p' }),
    });
    assert.equal(replacement.status, 200);
    // At capacity, a seek that replaces its own playback is admitted: its old jobs are free.
    const seek = await call('/prepare', {
      input,
      viewer: 'seven'.repeat(4),
      replaces: 'five'.repeat(5),
      request: request({ force: true, quality: '1080p', positionMs: 8000 }),
    });
    assert.equal(seek.status, 200, await seek.clone().text());
    await release('seven'.repeat(4));
    await release(gpuJob.lease);
    // ASS as it is, and the font attached to the file, for the browser.
    await exec('ffmpeg', [
      '-v',
      'error',
      '-i',
      `${dir}/source.mkv`,
      '-attach',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '-metadata:s:t',
      'mimetype=font/ttf',
      '-map',
      '0',
      '-c',
      'copy',
      '-c:s',
      'ass',
      `${dir}/fonted.mkv`,
    ]);
    const fonted = `${origin}/party/guest/source/fonted${'d'.repeat(36)}`;
    const fontedMeta = await (await call('/probe', { input: fonted })).json();
    assert.equal(fontedMeta.fonts.length, 1);
    const ready = async (path, body) => {
      let res = await call(path, body);
      for (let i = 0; i < 100 && res.status === 425; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        res = await call(path, body);
      }
      return res;
    };
    const ass = await ready('/subtitle', {
      input: fonted,
      file: 'fonted-file',
      index: 2,
      format: 'ass',
    });
    assert.equal(ass.status, 200);
    const assText = await ass.text();
    assert.match(assText, /\[Script Info\]/);
    assert.match(assText, /Dialogue:.*Guest playback/);
    // Only in the format the track is.
    assert.equal(
      (
        await call('/subtitle', {
          input: fonted,
          file: 'fonted-file',
          index: 2,
          format: 'sup',
        })
      ).status,
      400
    );
    const font = await ready('/font', {
      input: fonted,
      index: fontedMeta.fonts[0].index,
    });
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/ttf');
    const bytes = Buffer.from(await font.arrayBuffer());
    assert.deepEqual(
      bytes,
      await readFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    );
    assert.equal(
      (await call('/font', { input: fonted, index: 0 })).status,
      400
    );
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

test('real FFmpeg: surround stays at its layout as FLAC, up to 7.1, in order', async () => {
  // Each channel its own level, so a channel moved or mixed shows.
  const levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const tone = (n) =>
    levels
      .slice(0, n)
      .map((l) => `${l}*sin(2*PI*440*t)`)
      .join('|');
  const convert = async (name, layout, n, capabilities) => {
    const input = `${dir}/${name}.mkv`,
      output = `${dir}/${name}-out`;
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
      `aevalsrc=${tone(n)}:c=${layout}:s=48000`,
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'pcm_s24le',
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
        capabilities: {
          video: true,
          audio: false,
          container: false,
          hdr: false,
          ...capabilities,
        },
      }),
      output
    );
    await exec('ffmpeg', command.args, { timeout: 60000 });
    const { streams, mpd } = await dashOutput(output);
    const probe = JSON.parse(
      (
        await exec('ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-of',
          'json',
          streams[1],
        ])
      ).stdout
    ).streams[0];
    const { stderr } = await exec('ffmpeg', [
      '-i',
      streams[1],
      '-af',
      'astats=measure_overall=none:measure_perchannel=Peak_level',
      '-f',
      'null',
      '-',
    ]);
    const peaks = [...stderr.matchAll(/Peak level dB: (-?[\d.]+)/g)].map((m) =>
      Number(m[1])
    );
    return { probe, mpd, peaks };
  };
  const db = (l) => 20 * Math.log10(l);
  const lossless = { surround: true, lossless: true };

  const wide = await convert('flac71', '7.1', 8, lossless);
  assert.equal(wide.probe.codec_name, 'flac');
  assert.equal(wide.probe.channels, 8);
  assert.equal(wide.probe.channel_layout, '7.1');
  assert.match(wide.mpd, /codecs="flac"/);
  assert.equal(wide.peaks.length, 8);
  wide.peaks.forEach((peak, i) =>
    assert.ok(Math.abs(peak - db(levels[i])) < 0.1, `channel ${i}: ${peak}`)
  );

  // 5.1 isn't widened to 7.1.
  const five = await convert('flac51', '5.1', 6, lossless);
  assert.equal(five.probe.codec_name, 'flac');
  assert.equal(five.probe.channels, 6);
  five.peaks.forEach((peak, i) =>
    assert.ok(Math.abs(peak - db(levels[i])) < 0.1, `channel ${i}: ${peak}`)
  );

  // Without FLAC: 5.1 AAC, a 7.1 source folded into it.
  const aac = await convert('aac71', '7.1', 8, { surround: true });
  assert.equal(aac.probe.codec_name, 'aac');
  assert.equal(aac.probe.channels, 6);
});

test('progress: out_time is read once FFmpeg has written something', () => {
  assert.equal(outTimeMs('out_time_us=4000000'), 4000);
  // before the first packet is written
  assert.equal(outTimeMs('out_time_us=N/A'), null);
  assert.equal(outTimeMs('out_time_us='), null);
  assert.equal(outTimeMs('speed=4.2x'), null);
});

test('metadata: bit depth, field order, aspect ratio, HDR10+ and Dolby Vision layers', () => {
  const meta = metadata({
    format: { duration: '10' },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        pix_fmt: 'yuv420p10le',
        field_order: 'progressive',
        sample_aspect_ratio: '1:1',
        side_data_list: [
          {
            side_data_type: 'DOVI configuration record',
            dv_profile: 7,
            dv_bl_signal_compatibility_id: 6,
            bl_present_flag: 1,
            el_present_flag: 1,
            rpu_present_flag: 1,
          },
        ],
      },
      {
        index: 1,
        codec_type: 'video',
        codec_name: 'h264',
        pix_fmt: 'yuv420p',
        bits_per_raw_sample: '8',
        field_order: 'tt',
        sample_aspect_ratio: '32:27',
      },
      { index: 2, codec_type: 'audio', codec_name: 'aac' },
    ],
    // The first video frame, from its own probe.
    frames: [
      {
        stream_index: 0,
        side_data_list: [
          { side_data_type: 'Mastering display metadata' },
          { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' },
        ],
      },
    ],
  });
  const [hevc, h264, aac] = meta.tracks;
  assert.equal(hevc.bitDepth, 10);
  assert.equal(hevc.fieldOrder, 'progressive');
  assert.equal(hevc.sampleAspectRatio, '1:1');
  assert.equal(hevc.hdr10plus, true);
  assert.deepEqual(hevc.dovi, {
    profile: 7,
    compatibility: 6,
    layers: { base: true, enhancement: true, rpu: true },
  });
  // Interlaced and anamorphic; no HDR10+ seen on its frames
  assert.equal(h264.bitDepth, 8);
  assert.equal(h264.fieldOrder, 'tt');
  assert.equal(h264.sampleAspectRatio, '32:27');
  assert.equal(h264.hdr10plus, false);
  assert.equal(h264.dovi, undefined);
  // Audio has none of them
  assert.equal(aac.bitDepth, undefined);
  assert.equal(aac.hdr10plus, undefined);
});

test('metadata: the Dolby Vision fixture, probed for real', async () => {
  const raw = JSON.parse(
    (
      await exec('ffprobe', [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        new URL('./fixtures/dolby-vision-p5.mkv', import.meta.url).pathname,
      ])
    ).stdout
  );
  const [video] = metadata(raw).tracks;
  assert.deepEqual(video.dovi, {
    profile: 5,
    compatibility: 0,
    layers: { base: true, enhancement: false, rpu: true },
  });
  assert.equal(video.sampleAspectRatio, '1:1');
});
