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
  // With the video copied, the audio starts at the same keyframe rather than
  // at the seek, as Plex does: no stretch of picture without sound.
  if (policy.copyVideo) args.push('-noaccurate_seek');
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
  if (policy.copyVideo) {
    args.push('-c:v', 'copy');
    // Browsers and Safari's player expect HEVC tagged hvc1.
    if (policy.video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
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
  if (policy.audio && !policy.copyAudio)
    // Keeps converted audio continuous where the source's has gaps (Plex).
    args.push('-af', 'aresample=async=1', '-ac', '2', '-b:a', '192k');
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
    // DASH, video and audio in separate streams (as Plex does), each with
    // its own segments and timestamps.
    '-f',
    'dash',
    '-dash_segment_type',
    'mp4',
    '-seg_duration',
    '4',
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    '-adaptation_sets',
    policy.audio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
    // Each fragment's timestamps (tfdt) are the source's, as the manifest
    // says, not an edit list, which browsers don't apply; no sidx, which
    // makes FFmpeg rewrite timestamps at open-GOP boundaries.
    '-format_options',
    'movflags=+frag_discont+skip_sidx',
    '-init_seg_name',
    'init-$RepresentationID$.m4s',
    '-media_seg_name',
    'chunk-$RepresentationID$-$Number%05d$.m4s',
    `${output}/manifest.mpd`
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
const child = (data, box, type) => {
  if (!box) return null;
  for (const found of boxes(data, box[1], box[2]))
    if (found[0] === type) return found;
  return null;
};
const hex = (n) => n.toString(16).toUpperCase();
/**
 * The RFC 6381 codec string of the video in an init segment, from its
 * configuration box. FFmpeg's DASH muxer writes only "hvc1", "av01" or
 * "vp09", which browsers reject. Null when there's nothing to build from.
 */
export function videoCodec(init) {
  const whole = [null, 0, init.length];
  const stbl = child(
    init,
    child(
      init,
      child(init, child(init, child(init, whole, 'moov'), 'trak'), 'mdia'),
      'minf'
    ),
    'stbl'
  );
  const stsd = child(init, stbl, 'stsd');
  if (!stsd) return null;
  // stsd: version, flags and entry count, then the sample entry.
  const entry = boxes(init, stsd[1] + 8, stsd[2]).next().value;
  if (!entry) return null;
  const [type, from, to] = entry;
  // A visual sample entry's fields come before its child boxes.
  const config = (name) => {
    for (const box of boxes(init, from + 78, to))
      if (box[0] === name) return box;
    return null;
  };
  if (type === 'hvc1' || type === 'hev1') {
    const c = config('hvcC');
    if (!c) return null;
    const b = init.subarray(c[1], c[2]);
    const space = ['', 'A', 'B', 'C'][b[1] >> 6];
    const tier = b[1] & 0x20 ? 'H' : 'L';
    const profile = b[1] & 0x1f;
    // The compatibility flags, bit-reversed.
    let flags = b.readUInt32BE(2),
      reversed = 0;
    for (let i = 0; i < 32; i++) {
      reversed = (reversed << 1) | (flags & 1);
      flags >>>= 1;
    }
    const constraints = [...b.subarray(6, 12)];
    while (constraints.length && !constraints.at(-1)) constraints.pop();
    return [
      type,
      `${space}${profile}`,
      hex(reversed >>> 0),
      `${tier}${b[12]}`,
      ...constraints.map(hex),
    ].join('.');
  }
  if (type === 'avc1' || type === 'avc3') {
    const c = config('avcC');
    if (!c) return null;
    return `${type}.${[1, 2, 3]
      .map((i) => init[c[1] + i].toString(16).padStart(2, '0'))
      .join('')}`;
  }
  if (type === 'av01') {
    const c = config('av1C');
    if (!c) return null;
    const p = init[c[1] + 1],
      q = init[c[1] + 2];
    const depth = q & 0x40 ? (q & 0x20 ? 12 : 10) : 8;
    return `av01.${p >> 5}.${String(p & 0x1f).padStart(2, '0')}${q & 0x80 ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
  }
  if (type === 'vp09') {
    const c = config('vpcC');
    if (!c) return null;
    // A full box: version and flags first.
    const [profile, level, bits] = [4, 5, 6].map((i) => init[c[1] + i]);
    return `vp09.${[profile, level, bits >> 4]
      .map((n) => String(n).padStart(2, '0'))
      .join('.')}`;
  }
  return null;
}
/** Whether every stream in the manifest has a segment written. */
export function manifestReady(mpd) {
  const sets = mpd.split('<AdaptationSet').slice(1);
  return sets.length > 0 && sets.every((set) => /<S [^>]*d="/.test(set));
}
/**
 * Where a converted stream can play from, in seconds of the source: the
 * point every stream in the manifest has started. Null if none is listed.
 */
export function manifestStart(mpd) {
  let start = -Infinity;
  for (const [, template] of mpd.matchAll(
    /<SegmentTemplate([\s\S]*?)<\/SegmentTemplate>/g
  )) {
    const scale = Number(/timescale="(\d+)"/.exec(template)?.[1]);
    const first = Number(/<S t="(\d+)"/.exec(template)?.[1]);
    if (scale > 0 && Number.isFinite(first))
      start = Math.max(start, first / scale);
  }
  return Number.isFinite(start) ? start : null;
}
/** The manifest with the video's full codec string in place of FFmpeg's bare one. */
export function withVideoCodec(mpd, codec) {
  if (!codec) return mpd;
  return mpd.replace(
    /(mimeType="video\/mp4" codecs=")([a-z0-9]{4})(")/,
    (whole, a, bare, b) =>
      codec.startsWith(bare.slice(0, 3)) ? `${a}${codec}${b}` : whole
  );
}
