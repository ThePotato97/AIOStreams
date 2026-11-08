/** Pure media policy, shared by the worker and its tests. */

/**
 * How a subtitle reaches the browser: text as WebVTT, ASS/SSA for JASSUB,
 * PGS for libpgs. Anything else (VobSub, DVB) can only be burned in.
 */
export function subtitleKind(codec) {
  if (['subrip', 'webvtt', 'mov_text', 'text'].includes(codec)) return 'text';
  if (codec === 'ass' || codec === 'ssa') return 'ass';
  if (codec === 'hdmv_pgs_subtitle') return 'pgs';
  return null;
}
const FONT_FILE = /\.(ttf|otf|ttc|woff2?)$/i;
const isFont = (s) =>
  s.codec_type === 'attachment' &&
  (/font|truetype|opentype/i.test(s.tags?.mimetype ?? '') ||
    FONT_FILE.test(s.tags?.filename ?? ''));
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
        pixelFormat: s.pix_fmt,
        transfer: s.color_transfer,
        rotation: rotation(s),
        dovi: dovi(s),
        // Dolby Vision profile 5 has no HDR10 base layer (and often no colour
        // tags): HDR all the same, whose colours only its RPU makes right.
        hdr:
          ['smpte2084', 'arib-std-b67'].includes(s.color_transfer) ||
          dovi(s)?.profile === 5,
        title:
          s.tags?.title ?? s.tags?.language ?? `${s.codec_type} ${s.index}`,
        language: s.tags?.language,
        default: !!s.disposition?.default,
      })),
    // Fonts attached to the file, which its ASS subtitles are styled with.
    fonts: streams.filter(isFont).map((s) => ({
      index: s.index,
      filename: s.tags?.filename ?? `font-${s.index}`,
      mimetype: s.tags?.mimetype ?? 'font/ttf',
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
/** The stream's Dolby Vision configuration record, if any. */
function dovi(s) {
  const record = (s.side_data_list ?? []).find(
    (d) => d.side_data_type === 'DOVI configuration record'
  );
  return record
    ? {
        profile: Number(record.dv_profile),
        compatibility: Number(record.dv_bl_signal_compatibility_id),
      }
    : undefined;
}
/** Degrees the display matrix rotates the picture by, 0 without one. */
function rotation(s) {
  const matrix = (s.side_data_list ?? []).find(
    (d) => d.side_data_type === 'Display Matrix'
  );
  return Number(matrix?.rotation) || 0;
}
function rate(value) {
  const [a, b = 1] = String(value ?? '0')
    .split('/')
    .map(Number);
  return b && Number.isFinite(a / b) ? a / b : 0;
}
/** Audio codecs atmos-render reads, and the raw format FFmpeg hands them over in. */
export const BINAURAL_CODECS = { truehd: 'truehd', eac3: 'eac3' };
/**
 * The demuxing FFmpeg of a binaural conversion: the source's audio track as a raw elementary
 * stream on pipe:1 for atmos-render, and the same packets' timestamps (framemd5, flushed per
 * packet) on pipe:3, whose first gives where the rendered audio starts.
 */
export function demuxArgs(input, policy, offset) {
  const format = BINAURAL_CODECS[policy.audio.codec];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-ss',
    String(offset),
    ...(/^https?:/.test(input)
      ? [
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_on_network_error',
          '1',
          '-reconnect_delay_max',
          '30',
        ]
      : []),
    '-copyts',
    '-i',
    input,
    '-map',
    `0:${policy.audio.index}`,
    '-c',
    'copy',
    '-f',
    format,
    'pipe:1',
    '-map',
    `0:${policy.audio.index}`,
    '-c',
    'copy',
    '-flush_packets',
    '1',
    '-f',
    'framemd5',
    'pipe:3',
  ];
}
/** atmos-render's arguments for a policy's audio track. */
export function rendererArgs(policy) {
  const format = BINAURAL_CODECS[policy.audio.codec];
  return [
    '--format',
    format,
    ...(format === 'eac3' ? ['--ffmpeg', 'ffmpeg'] : []),
  ];
}
/**
 * The first packet's timestamp in seconds, from framemd5 output (a "#tb 0: 1/1000" header,
 * then "0, dts, pts, duration, size, hash" lines); null until there is one.
 */
export function firstPacketTime(text) {
  let tb = null;
  for (const line of text.split('\n')) {
    const header = /^#tb \d+: (\d+)\/(\d+)/.exec(line);
    if (header) tb = Number(header[1]) / Number(header[2]);
    else if (tb && /^\d+,/.test(line)) {
      const fields = line.split(',').map((f) => f.trim());
      if (fields.length < 6) return null;
      const pts = Number(fields[2]);
      return Number.isFinite(pts) ? pts * tb : null;
    }
  }
  return null;
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
  // Burned in only where the browser can't draw it itself.
  const kind = subtitle && subtitleKind(subtitle.codec);
  const burn =
    !!subtitle &&
    kind !== 'text' &&
    !(kind && (caps.subtitles ?? []).includes(kind));
  // A successful probe of the actual file is required, not a guessed codec name.
  const copyVideo =
    !!video &&
    !burn &&
    original &&
    !request.force &&
    caps.video === true &&
    (!video.hdr || caps.hdr === true) &&
    // No browser capability for Dolby Vision is reported: profile 5 shown
    // as HDR10 has the wrong colours, so it is always converted.
    video.dovi?.profile !== 5;
  // Rendered to binaural here (atmos-render, Dolby Atmos for Headphones' renderer) where the
  // player asks for it and the track is one the renderer reads: TrueHD or E-AC-3 at 48 kHz.
  const renderable =
    !!audio &&
    caps.binaural === true &&
    BINAURAL_CODECS[audio.codec] !== undefined &&
    (audio.sampleRate ?? 48000) === 48000;
  // The player renders it itself where it can (in WebAssembly): the track is copied as it is.
  // Not on a retry after failed playback, which renders it here instead.
  const clientBinaural =
    renderable &&
    !request.force &&
    (caps.clientBinaural ?? []).includes(audio.codec);
  const binaural = renderable && !clientBinaural;
  const copyAudio =
    !!audio &&
    !binaural &&
    (clientBinaural || (original && !request.force && caps.audio === true));
  const direct =
    original &&
    !request.force &&
    // The player's own rendering reads the DASH stream.
    !clientBinaural &&
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
              : video.dovi?.profile === 5
                ? 'Dolby Vision profile 5'
                : "HDR the browser can't show";
  const audioReason =
    !audio || copyAudio
      ? null
      : binaural
        ? 'binaural rendering'
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
    binaural,
    clientBinaural,
  };
}
/*
 * Video conversion follows Jellyfin's chains (EncodingHelper.cs) on
 * jellyfin-ffmpeg: on NVIDIA, NVDEC decode, scale_cuda and tonemap_cuda with
 * the frames kept on the GPU into NVENC; tonemap_cuda on uploaded frames
 * where NVDEC can't decode; tonemapx on the CPU otherwise. Jellyfin's
 * filters apply a Dolby Vision RPU (apply_dovi, on by default), which is
 * what gives profile 5 its colours. The curve is Hable without
 * desaturation, as before (Jellyfin's default is BT.2390).
 */
const TONEMAP = 'tonemap=hable:desat=0:t=bt709:m=bt709:p=bt709:range=tv';
/** Jellyfin's GetInputHdrParam: the source's HDR colour tags, made explicit. */
const hdrParams = (video) =>
  `setparams=color_primaries=bt2020:color_trc=${video.transfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084'}:colorspace=bt2020nc`;
const SDR_PARAMS =
  'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';
/** Jellyfin's GetNvdecVidDecoder: the codecs and formats NVDEC decodes. */
export function nvdecDecodes(video) {
  const f = video?.pixelFormat;
  const b8 = f === 'yuv420p' || f === 'yuvj420p';
  const b10 = b8 || f === 'yuv420p10le';
  const b12 =
    b10 || ['yuv444p', 'yuv444p10le', 'yuv420p12le', 'yuv444p12le'].includes(f);
  const codec = video?.codec;
  if (['h264', 'mpeg2video', 'vc1', 'mpeg4', 'vp8'].includes(codec)) return b8;
  if (['vp9', 'av1'].includes(codec)) return b10;
  if (codec === 'hevc') return b12;
  return false;
}
/**
 * `options.decode`: 'gpu' decodes on the NVIDIA GPU where it can, 'cpu'
 * never. `options.tonemap`: 'gpu' tone-maps HDR on the NVIDIA GPU, 'cpu' on
 * the CPU. Both only apply when encoding with NVENC.
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
  // Frames stay on the GPU from NVDEC to NVENC. Not with burn-in (its
  // overlay is on the CPU) nor a rotated picture (FFmpeg's autorotate is on
  // the CPU), and only with HDR tone-mapped on the GPU too.
  const gpuDecode =
    encoder === 'nvidia' &&
    (options.decode ?? 'gpu') === 'gpu' &&
    !policy.copyVideo &&
    !policy.burn &&
    !policy.video?.rotation &&
    nvdecDecodes(policy.video) &&
    (!policy.video?.hdr || gpuTonemap);
  if (gpuTonemap || gpuDecode)
    args.push('-init_hw_device', 'cuda=cu:0', '-filter_hw_device', 'cu');
  if (gpuDecode)
    args.push(
      '-hwaccel',
      'cuda',
      '-hwaccel_device',
      'cu',
      '-hwaccel_output_format',
      'cuda'
    );
  // Seek before input for ordinary streams. Burn-in retains the source timeline.
  if (!policy.burn) args.push('-ss', String(offset));
  // With the video copied, the audio starts at the same keyframe rather than
  // at the seek, as Plex does: no stretch of picture without sound.
  if (policy.copyVideo) args.push('-noaccurate_seek');
  // A job paused ahead of its viewers leaves the source connection idle,
  // which the source may close: read on from where it was.
  if (/^https?:/.test(input))
    args.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_delay_max',
      '30'
    );
  args.push('-i', input);
  // A binaural conversion's audio: atmos-render's 48 kHz float stereo on pipe:4, starting at the
  // source timestamp of the first audio packet (options.audioStart, seconds).
  if (policy.binaural)
    args.push(
      '-f',
      'f32le',
      '-ar',
      '48000',
      '-ch_layout',
      'stereo',
      '-itsoffset',
      String(options.audioStart ?? offset),
      '-i',
      'pipe:4'
    );
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
  if (policy.audio)
    args.push('-map', policy.binaural ? '1:a' : `0:${policy.audio.index}`);
  if (policy.copyVideo) {
    args.push('-c:v', 'copy');
    // Browsers and Safari's player expect HEVC tagged hvc1.
    if (policy.video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    const height =
      request.quality === '720p'
        ? 720
        : request.quality === '1080p'
          ? 1080
          : null;
    const hdr = !!policy.video?.hdr;
    if (gpuDecode) {
      // Jellyfin's GetNvidiaVidFiltersPrefered with NVDEC and NVENC.
      const size = height
        ? `w=-2:h='trunc(min(${height},ih)/2)*2'`
        : `w='trunc(iw/2)*2':h='trunc(ih/2)*2'`;
      // HEVC range extensions (4:4:4, 12-bit) go to tonemap_cuda as P010.
      const rext = !['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(
        policy.video.pixelFormat
      );
      filters.push(
        hdr ? hdrParams(policy.video) : SDR_PARAMS,
        `scale_cuda=${size}${hdr ? (rext ? ':format=p010' : '') : ':format=yuv420p'}`
      );
      if (hdr) filters.push(`tonemap_cuda=${TONEMAP}:format=yuv420p`);
    } else {
      if (hdr) filters.push(hdrParams(policy.video));
      // Scaled before the tone map, as Jellyfin does: fewer pixels to map.
      if (height) filters.push(`scale=w=-2:h='min(${height},ih)'`);
      if (hdr)
        filters.push(
          gpuTonemap
            ? // Jellyfin's chain for frames decoded on the CPU.
              `format=p010le,hwupload,tonemap_cuda=${TONEMAP}:format=yuv420p,hwdownload`
            : `tonemapx=${TONEMAP}:format=yuv420p`
        );
      filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p');
    }
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
    // Forced keyframes are IDR frames only when asked: otherwise segments
    // can't be cut on them and follow NVENC's own keyframe interval (Plex).
    if (codec === 'h264_nvenc')
      args.push('-preset', 'p4', '-cq', '20', '-forced-idr', '1');
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
  // TrueHD in MP4 (mlpa) is behind FFmpeg's experimental flag.
  if (policy.copyAudio && policy.audio.codec === 'truehd')
    args.push('-strict', 'experimental');
  if (policy.binaural) {
    // Already stereo for headphones: FLAC where the browser plays it, else AAC.
    args.push(
      ...(request.capabilities?.lossless === true
        ? ['-c:a', 'flac', '-sample_fmt', 's32']
        : ['-b:a', '192k'])
    );
  } else if (policy.audio && !policy.copyAudio) {
    // Surround stays surround where wanted (a surround output, or the
    // player's virtual surround for headphones): lossless FLAC at the
    // source's layout, up to 7.1, where the browser plays it, else 5.1 AAC
    // (AAC's own 7.1 places its extra pair as front wides). The browser
    // downmixes to the speakers there are.
    const channels = policy.audio.channels ?? 2;
    const surround = request.capabilities?.surround === true && channels > 2;
    const lossless = surround && request.capabilities?.lossless === true;
    const layout = !surround
      ? 'stereo'
      : lossless && channels > 6
        ? '7.1'
        : '5.1';
    args.push(
      '-af',
      // Continuous where the source's audio has gaps, and downmixed without
      // clipping, as Plex does: a plain -ac 2 peaks over 0 dBFS.
      `aresample=async=1:ochl=${layout}:rematrix_maxval=1`,
      '-ac',
      String({ stereo: 2, 5.1: 6, 7.1: 8 }[layout]),
      ...(lossless
        ? // 24-bit, as TrueHD and DTS-HD MA decode to.
          ['-c:a', 'flac', '-sample_fmt', 's32']
        : ['-b:a', surround ? '384k' : '192k'])
    );
  }
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
  // Where the video was decoded and HDR tone-mapped, for the fallback and
  // /health.
  const tonemap =
    policy.video?.hdr && !policy.copyVideo
      ? gpuTonemap
        ? 'gpu'
        : 'cpu'
      : null;
  const decode = policy.copyVideo ? null : gpuDecode ? 'gpu' : 'cpu';
  return { args, offsetMs: offset * 1000, offset, policy, tonemap, decode };
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
/** The manifest's codec string for an audio track copied as it is, where FFmpeg writes none. */
export function audioCodec(policy) {
  return policy.copyAudio && policy.audio?.codec === 'truehd' ? 'mlpa' : null;
}
/** Fills in an audio representation's empty codec string (FFmpeg writes none for TrueHD). */
export function withAudioCodec(mpd, codec) {
  if (!codec) return mpd;
  return mpd.replace(/(mimeType="audio\/mp4" codecs=")(")/, `$1${codec}$2`);
}
export function withVideoCodec(mpd, codec) {
  if (!codec) return mpd;
  // FFmpeg 6.1 writes the bare sample entry (hvc1); 8.1 writes nothing for copied HEVC.
  return mpd.replace(
    /(mimeType="video\/mp4" codecs=")([a-z0-9]{4})?(")/,
    (whole, a, bare, b) =>
      !bare || codec.startsWith(bare.slice(0, 3)) ? `${a}${codec}${b}` : whole
  );
}

/**
 * A finished manifest says the presentation lasts as long as the source.
 * FFmpeg writes the length it converted, while the segments keep the
 * source's timestamps: a job from 40 s of a 60 s file says 20 s, with every
 * segment past that end.
 */
export function withFullDuration(mpd, durationMs) {
  if (!(durationMs > 0)) return mpd;
  return mpd.replace(
    /mediaPresentationDuration="[^"]*"/,
    `mediaPresentationDuration="PT${(durationMs / 1000).toFixed(3)}S"`
  );
}
