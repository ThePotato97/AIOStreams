/** Pure media policy, shared by the worker and its tests. */
export function metadata(raw) {
  const streams = raw.streams ?? [];
  return {
    durationMs: duration(raw),
    container: raw.format?.format_name ?? '',
    bitrate: Number(raw.format?.bit_rate || 0),
    tracks: streams
      .filter((s) => ['video', 'audio', 'subtitle'].includes(s.codec_type))
      .map((s) => ({
        index: s.index,
        type: s.codec_type,
        codec: s.codec_name,
        profile: s.profile,
        level: s.level,
        width: s.width,
        height: s.height,
        frameRate: rate(s.avg_frame_rate),
        bitrate: Number(s.bit_rate || 0),
        channels: s.channels,
        sampleRate: Number(s.sample_rate || 48000),
        hdr: ['smpte2084', 'arib-std-b67'].includes(s.color_transfer),
        title:
          s.tags?.title ?? s.tags?.language ?? `${s.codec_type} ${s.index}`,
        language: s.tags?.language,
        default: !!s.disposition?.default,
      })),
    chapters: (raw.chapters ?? [])
      .map((c) => ({
        title: c.tags?.title ?? '',
        startMs: Number(c.start_time) * 1000,
      }))
      .filter((c) => Number.isFinite(c.startMs) && c.startMs >= 0)
      .sort((a, b) => a.startMs - b.startMs),
  };
}
/**
 * The container's duration, else the longest stream's. Matroska often carries
 * it only as a per-stream DURATION tag ("01:23:45.678000000").
 */
export function duration(raw) {
  const seconds = (value) => {
    if (value == null || value === '') return 0;
    const text = String(value);
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
    return match ? +match[1] * 3600 + +match[2] * 60 + +match[3] : 0;
  };
  let best = seconds(raw.format?.duration);
  if (!(best > 0))
    for (const s of raw.streams ?? [])
      best = Math.max(
        best,
        seconds(s.duration),
        seconds(s.tags?.DURATION ?? s.tags?.duration)
      );
  return Number.isFinite(best) && best > 0 ? Math.round(best * 1000) : 0;
}
function rate(value) {
  const [a, b = 1] = String(value ?? '0')
    .split('/')
    .map(Number);
  return b && Number.isFinite(a / b) ? a / b : 0;
}
export function select(meta, request) {
  const video = meta.tracks.find((t) => t.type === 'video');
  const audios = meta.tracks.filter((t) => t.type === 'audio');
  const audio =
    request.audio == null
      ? (audios.find((t) => t.default) ?? audios[0])
      : audios.find((t) => t.index === request.audio);
  const subtitle =
    request.subtitle == null
      ? null
      : meta.tracks.find(
          (t) => t.type === 'subtitle' && t.index === request.subtitle
        );
  if (
    (request.audio != null && !audio) ||
    (request.subtitle != null && !subtitle)
  )
    throw new Error('Unknown track');
  const caps = request.capabilities ?? {};
  const original = request.quality === 'original';
  const burn =
    !!subtitle &&
    !['subrip', 'webvtt', 'mov_text', 'text'].includes(subtitle.codec);
  // A successful probe of the actual file is required, not a guessed codec name.
  const copyVideo =
    !!video &&
    !burn &&
    original &&
    !request.force &&
    caps.video === true &&
    (!video.hdr || caps.hdr === true);
  const copyAudio =
    !!audio && original && !request.force && caps.audio === true;
  const direct =
    original &&
    !request.force &&
    caps.container === true &&
    copyVideo &&
    (!audio || copyAudio) &&
    !burn &&
    (request.audio == null || audio === audios[0]);
  // Why each stream is converted, for /health: the first cause that applies.
  const videoReason = !video
    ? null
    : copyVideo
      ? null
      : burn
        ? 'subtitle burn-in'
        : !original
          ? `quality ${request.quality}`
          : request.force
            ? 'retry after failed playback'
            : caps.video !== true
              ? "browser can't decode the video"
              : "HDR the browser can't show";
  const audioReason =
    !audio || copyAudio
      ? null
      : !original
        ? `quality ${request.quality}`
        : request.force
          ? 'retry after failed playback'
          : "browser can't decode the audio";
  return {
    videoReason,
    audioReason,
    mode: direct
      ? 'direct'
      : copyVideo
        ? copyAudio || !audio
          ? 'remux'
          : 'audio'
        : 'video',
    video,
    audio,
    subtitle,
    burn,
    copyVideo,
    copyAudio,
  };
}
/** Tone-maps HDR to SDR in floating point on the CPU. */
const CPU_TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
/** The same tone map on the GPU, through OpenCL, from 10-bit frames. */
const OPENCL_TONEMAP =
  'format=p010le,hwupload,tonemap_opencl=tonemap=hable:desat=0:transfer=bt709:matrix=bt709:primaries=bt709:range=tv:format=nv12,hwdownload,format=nv12';
/**
 * `options.tonemap`: 'gpu' tone-maps HDR on the NVIDIA GPU (OpenCL) when
 * encoding with it; 'cpu' always uses the CPU.
 */
export function ffmpegArgs(
  input,
  meta,
  request,
  output,
  encoder = 'cpu',
  options = {}
) {
  const policy = select(meta, request);
  const offset =
    Math.floor(Math.max(0, request.positionMs ?? 0) / 1000 / 4) * 4;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const hw =
    encoder === 'vaapi' &&
    !policy.copyVideo &&
    !policy.burn &&
    !policy.video?.hdr;
  if (hw)
    args.push(
      '-vaapi_device',
      process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128'
    );
  const gpuTonemap =
    encoder === 'nvidia' &&
    (options.tonemap ?? 'gpu') === 'gpu' &&
    !policy.copyVideo &&
    !!policy.video?.hdr;
  if (gpuTonemap)
    args.push('-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl');
  // Seek before input for ordinary streams. Burn-in retains the source timeline.
  if (!policy.burn) args.push('-ss', String(offset));
  args.push('-i', input);
  const filters = [];
  if (policy.burn) {
    // FFmpeg's subtitle decoder feeds an overlay without
    // interpolating an untrusted URL into a filter expression.
    const sub = meta.tracks
      .filter((t) => t.type === 'subtitle')
      .findIndex((t) => t.index === policy.subtitle.index);
    if (['ass', 'ssa'].includes(policy.subtitle.codec)) {
      // The input is a server-generated, URL-safe source handle.
      filters.push(
        `subtitles=filename='${input.replace(/[:\\']/g, '\\$&')}':si=${sub}`
      );
    }
  }
  if (policy.burn) args.push('-ss', String(offset));
  args.push(
    '-map',
    policy.burn && !['ass', 'ssa'].includes(policy.subtitle.codec)
      ? '[vsub]'
      : `0:${policy.video.index}`
  );
  if (policy.audio) args.push('-map', `0:${policy.audio.index}`);
  if (policy.copyVideo) args.push('-c:v', 'copy');
  else {
    if (policy.video?.hdr)
      filters.push(gpuTonemap ? OPENCL_TONEMAP : CPU_TONEMAP);
    const height =
      request.quality === '720p'
        ? 720
        : request.quality === '1080p'
          ? 1080
          : null;
    if (height) filters.push(`scale=w=-2:h='min(${height},ih)'`);
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p');
    if (hw) filters.push('hwupload');
    if (policy.burn && !['ass', 'ssa'].includes(policy.subtitle.codec)) {
      args.push(
        '-filter_complex',
        `[0:${policy.video.index}][0:${policy.subtitle.index}]overlay,${filters.join(',')}[vsub]`
      );
    } else if (filters.length) args.push('-vf', filters.join(','));
    const codec = hw
      ? 'h264_vaapi'
      : encoder === 'nvidia'
        ? 'h264_nvenc'
        : 'libx264';
    args.push('-c:v', codec);
    if (codec === 'libx264') args.push('-preset', 'veryfast', '-crf', '20');
    if (codec === 'h264_nvenc') args.push('-preset', 'p4', '-cq', '20');
    if (codec === 'h264_vaapi' && !height) args.push('-qp', '20');
    if (height) {
      const bitrate = height === 720 ? '4M' : '8M';
      args.push(
        '-b:v',
        bitrate,
        '-maxrate',
        bitrate,
        '-bufsize',
        height === 720 ? '8M' : '16M'
      );
    }
    args.push(
      '-force_key_frames',
      'expr:gte(t,n_forced*4)',
      '-sc_threshold',
      '0'
    );
  }
  if (policy.audio) args.push('-c:a', policy.copyAudio ? 'copy' : 'aac');
  if (policy.audio && !policy.copyAudio) args.push('-ac', '2', '-b:a', '192k');
  args.push(
    '-sn',
    '-map_metadata',
    '-1',
    // Timestamps as in the source (from its start), as Jellyfin does: copied
    // video starts at the keyframe before the seek, the converted audio at the
    // seek itself, and only real timestamps keep the two in step in browsers.
    '-copyts',
    '-avoid_negative_ts',
    'disabled',
    '-start_at_zero',
    // Video read before the audio's first packet waits here.
    '-max_muxing_queue_size',
    '2048',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    // The audio's later start goes in each fragment's timestamps (tfdt), not
    // an edit list, which hls.js and MSE don't apply; no sidx, which makes
    // FFmpeg rewrite timestamps at open-GOP boundaries.
    '-hls_segment_options',
    'movflags=+frag_discont+skip_sidx',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    `${output}/segment-%06d.m4s`,
    `${output}/index.m3u8`
  );
  // Where HDR was tone-mapped, for the fallback and /health.
  const tonemap =
    policy.video?.hdr && !policy.copyVideo
      ? gpuTonemap
        ? 'gpu'
        : 'cpu'
      : null;
  return { args, offsetMs: offset * 1000, policy, tonemap };
}

/** The boxes in an ISO BMFF byte range: [type, start of content, end]. */
function* boxes(data, from = 0, to = data.length) {
  let at = from;
  while (at + 8 <= to) {
    let size = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield [type, at + header, at + size];
    at += size;
  }
}
const child = (data, from, to, type) => {
  for (const box of boxes(data, from, to)) if (box[0] === type) return box;
  return null;
};
/**
 * Where a converted stream starts, in seconds of the source: its first
 * fragment's earliest decode time (tfdt), which is where hls.js puts the
 * player's 0. Null if the segment can't be read.
 */
export function streamStart(init, segment) {
  const timescales = new Map();
  const moov = child(init, 0, init.length, 'moov');
  if (!moov) return null;
  for (const [type, from, to] of boxes(init, moov[1], moov[2])) {
    if (type !== 'trak') continue;
    const tkhd = child(init, from, to, 'tkhd');
    const mdia = child(init, from, to, 'mdia');
    const mdhd = mdia && child(init, mdia[1], mdia[2], 'mdhd');
    if (!tkhd || !mdhd) continue;
    const id = init.readUInt32BE(tkhd[1] + (init[tkhd[1]] === 1 ? 20 : 12));
    timescales.set(
      id,
      init.readUInt32BE(mdhd[1] + (init[mdhd[1]] === 1 ? 20 : 12))
    );
  }
  const moof = child(segment, 0, segment.length, 'moof');
  if (!moof) return null;
  let start = Infinity;
  for (const [type, from, to] of boxes(segment, moof[1], moof[2])) {
    if (type !== 'traf') continue;
    const tfhd = child(segment, from, to, 'tfhd');
    const tfdt = child(segment, from, to, 'tfdt');
    if (!tfhd || !tfdt) continue;
    const scale = timescales.get(segment.readUInt32BE(tfhd[1] + 4));
    if (!scale) continue;
    const time =
      segment[tfdt[1]] === 1
        ? Number(segment.readBigInt64BE(tfdt[1] + 4))
        : segment.readUInt32BE(tfdt[1] + 4);
    // AAC's priming before 0 is negative, which hls.js ignores too.
    if (time >= 0) start = Math.min(start, time / scale);
  }
  return Number.isFinite(start) ? start : null;
}
