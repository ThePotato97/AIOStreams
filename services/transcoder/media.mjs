/** Pure media policy, shared by the worker and its tests. */

/**
 * How a subtitle reaches the browser: text as WebVTT, ASS/SSA for JASSUB,
 * PGS for libpgs. Anything else (VobSub, DVB) can only be burned in.
 */
export function subtitleKind(codec) {
  if (['subrip', 'webvtt', 'mov_text', 'text'].includes(codec)) return 'text';
  if (codec === 'ass' || codec === 'ssa') return 'ass';
  if (codec === 'hdmv_pgs_subtitle') return 'pgs';
  // Bitmaps the page doesn't draw yet: burned in until it does.
  if (codec === 'dvd_subtitle') return 'vobsub';
  if (codec === 'dvb_subtitle') return 'dvb';
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
        bitDepth: bitDepth(s),
        // progressive, or the field order of interlaced video (tt, bb, tb, bt)
        fieldOrder: s.field_order,
        sampleAspectRatio: s.sample_aspect_ratio,
        transfer: s.color_transfer,
        rotation: rotation(s),
        dovi: dovi(s),
        // HDR10+ dynamic metadata, seen on the first video frame (a separate probe)
        hdr10plus:
          s.codec_type === 'video'
            ? (raw.frames ?? []).some(
                (f) =>
                  f.stream_index === s.index &&
                  (f.side_data_list ?? []).some(
                    (d) => d.side_data_type === HDR10_PLUS
                  )
              )
            : undefined,
        // Dolby Vision profile 5 has no HDR10 base layer (and often no colour
        // tags): HDR all the same, whose colours only its RPU makes right.
        hdr:
          ['smpte2084', 'arib-std-b67'].includes(s.color_transfer) ||
          dovi(s)?.profile === 5,
        title:
          s.tags?.title ?? s.tags?.language ?? `${s.codec_type} ${s.index}`,
        language: s.tags?.language,
        layout: s.channel_layout,
        default: !!s.disposition?.default,
        forced: !!s.disposition?.forced,
        hearingImpaired: !!s.disposition?.hearing_impaired,
        visualImpaired: !!s.disposition?.visual_impaired,
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
/** FFmpeg's name for HDR10+ (SMPTE ST 2094-40) frame metadata. */
const HDR10_PLUS = 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)';
/** The stream's Dolby Vision configuration record, if any: profile, and which layers it has. */
function dovi(s) {
  const record = (s.side_data_list ?? []).find(
    (d) => d.side_data_type === 'DOVI configuration record'
  );
  return record
    ? {
        profile: Number(record.dv_profile),
        compatibility: Number(record.dv_bl_signal_compatibility_id),
        layers: {
          base: Number(record.bl_present_flag) === 1,
          enhancement: Number(record.el_present_flag) === 1,
          rpu: Number(record.rpu_present_flag) === 1,
        },
      }
    : undefined;
}
/** Bits per sample of a video stream, from FFmpeg's count or its pixel format's name. */
function bitDepth(s) {
  if (s.codec_type !== 'video') return undefined;
  const raw = Number(s.bits_per_raw_sample);
  if (Number.isInteger(raw) && raw > 0) return raw;
  const named = /p(\d+)(le|be)$/.exec(s.pix_fmt ?? '');
  return named ? Number(named[1]) : s.pix_fmt ? 8 : undefined;
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
/**
 * Audio codecs atmos-render reads, and the raw format FFmpeg hands them over in: TrueHD and
 * E-AC-3 (with Atmos where they carry it), AC-3, and DTS (DTS-HD included; channels only, as
 * FFmpeg decodes it).
 */
export const BINAURAL_CODECS = {
  truehd: 'truehd',
  eac3: 'eac3',
  ac3: 'ac3',
  dts: 'dts',
};
/** The ones atmos-render decodes with an FFmpeg child of its own. */
const DECODED_BY_FFMPEG = new Set(['eac3', 'ac3', 'dts']);
/**
 * The demuxing FFmpeg of a binaural conversion: the source's audio track as a raw elementary
 * stream on pipe:1 for atmos-render, and the same packets' timestamps (framemd5, flushed per
 * packet) on pipe:3, whose first gives where the rendered audio starts.
 */
export function demuxArgs(input, meta, spec, offset) {
  const audio = tracksOf(meta, spec).audio;
  const format = BINAURAL_CODECS[audio.codec];
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
          String(RECONNECT_DELAY_MAX_S),
        ]
      : []),
    '-copyts',
    '-i',
    input,
    '-map',
    `0:${audio.index}`,
    '-c',
    'copy',
    '-f',
    format,
    'pipe:1',
    '-map',
    `0:${audio.index}`,
    '-c',
    'copy',
    '-flush_packets',
    '1',
    '-f',
    'framemd5',
    'pipe:3',
  ];
}
/** The listener's headphone mode as atmos-render's --modes: everything Near (as Windows) or Far. */
const RENDER_MODES = { near: 'windows', far: 'far' };

/** atmos-render's arguments for a spec's audio track. */
export function rendererArgs(meta, spec) {
  const format = BINAURAL_CODECS[tracksOf(meta, spec).audio.codec];
  const modes = RENDER_MODES[spec.audio.render?.mode];
  return [
    '--format',
    format,
    ...(DECODED_BY_FFMPEG.has(format) ? ['--ffmpeg', 'ffmpeg'] : []),
    // Without one, each element in the stream's own mode (Mid where it has none).
    ...(modes ? ['--modes', modes] : []),
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
/**
 * Where each stream's work happens and what it outputs. Every value a planned feature needs has
 * its place here; `playbackSpec` chooses only the values built so far (marked "built").
 *
 * @typedef {object} VideoSpec
 * @property {number} track
 * @property {'page-original'|'page-demux'|'server-copy'|'server-encode'} where
 *   The original file played by the page (built), demuxed by the page, copied (built) or
 *   encoded (built) on the server.
 * @property {null | {codec: 'h264'|'hevc10'|'av1', range: 'sdr'|'hdr10',
 *   tonemap: 'none'|'server', deinterlace: boolean, scale: number|null,
 *   maxBitrate: string|null}} encode
 *   A server encode: built are h264, sdr, the server's tone map, no deinterlacing; `scale` is the
 *   output height (null: the source's), `maxBitrate` its cap.
 * @property {'none'|'dovi'|'tonemap-sdr'} picture
 *   What the page draws over the video: Dolby Vision (built), or HDR tone-mapped to SDR.
 * @property {string|null} reason Why the video isn't copied, for /health.
 *
 * @typedef {object} AudioSpec
 * @property {number} track
 * @property {'page-original'|'server-copy'|'server-convert'|'server-render'} where
 * @property {boolean} pageRenders Copied for the page to render (binaural or speakers) itself.
 * @property {null | {codec: 'flac'|'aac', layout: 'stereo'|'5.1'|'7.1', channels: number,
 *   bitrate: string|null}} convert A server conversion's output.
 * @property {null | {binaural: true, mode: 'near'|'far'|null, codec: 'flac'|'aac',
 *   bitrate: string|null}} render Rendered to binaural on the server, in the listener's mode
 *   (null: as mixed).
 * @property {string|null} reason Why the audio isn't copied, for /health.
 *
 * @typedef {object} SubtitleSpec
 * @property {number} track
 * @property {'page'|'server-burn'} where
 *   Drawn by the page (built for text, ASS, PGS; VobSub and DVB are burned in until it draws
 *   them), or burned in on the server.
 * @property {'text'|'ass'|'pgs'|'vobsub'|'dvb'|null} format
 *
 * @typedef {object} PlaybackSpec
 * @property {VideoSpec|null} video
 * @property {AudioSpec|null} audio
 * @property {SubtitleSpec|null} subtitle
 */

/** What the page asks to draw itself. */
const drawsDovi = (caps) =>
  Array.isArray(caps.picture) && caps.picture.includes('dovi');

const QUALITY_HEIGHT = { '720p': 720, '1080p': 1080 };
const QUALITY_BITRATE = { '720p': '4M', '1080p': '8M' };

/**
 * The spec from the media, the request (with what the player can do), and what the
 * transcoder knows: `binauralFailed`, this track's binaural rendering failed before (or just
 * now, before the stream started), so it isn't asked of the renderer again.
 * @param {{binauralFailed?: boolean}} [inputs]
 * @returns {PlaybackSpec}
 */
export function playbackSpec(meta, request, inputs = {}) {
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
  const format = subtitle ? subtitleKind(subtitle.codec) : null;
  const burn =
    !!subtitle &&
    format !== 'text' &&
    !(format && (caps.subtitles ?? []).includes(format));
  // A successful probe of the actual file is required, not a guessed codec name.
  const copyVideo =
    !!video &&
    !burn &&
    original &&
    !request.force &&
    caps.video === true &&
    (!video.hdr || caps.hdr === true) &&
    // Profile 5 shown as HDR10 has the wrong colours, so it's converted unless the player draws
    // Dolby Vision itself (from the RPUs).
    (video.dovi?.profile !== 5 || drawsDovi(caps));
  // Dolby Vision copied with its RPUs for the player to draw
  const dovi = copyVideo && !!video.dovi && drawsDovi(caps);
  // A track the renderer (atmos-render, Dolby Atmos for Headphones' renderer) reads: TrueHD,
  // E-AC-3, AC-3 or DTS at 48 kHz.
  const renderable =
    !!audio &&
    BINAURAL_CODECS[audio.codec] !== undefined &&
    (audio.sampleRate ?? 48000) === 48000;
  // The player decodes it itself where it can (in WebAssembly), with headphones on or off, so
  // turning them on or off doesn't need a new job: the track is copied as it is. Not on a retry
  // after failed playback, which converts it here instead.
  const pageRenders =
    renderable &&
    !request.force &&
    (caps.clientBinaural ?? []).includes(audio.codec);
  // Rendered to binaural here where the player asks for it and doesn't render it itself, unless
  // the renderer failed on this track.
  const binaural =
    renderable &&
    caps.binaural === true &&
    !inputs.binauralFailed &&
    !pageRenders;
  const copyAudio =
    !!audio &&
    !binaural &&
    (pageRenders || (original && !request.force && caps.audio === true));
  const direct =
    original &&
    !request.force &&
    // The player's own rendering (binaural audio, Dolby Vision) reads the DASH stream.
    !pageRenders &&
    !dovi &&
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
    video: video
      ? {
          track: video.index,
          where: direct
            ? 'page-original'
            : copyVideo
              ? 'server-copy'
              : 'server-encode',
          encode: copyVideo
            ? null
            : {
                codec: 'h264',
                range: 'sdr',
                tonemap: video.hdr ? 'server' : 'none',
                deinterlace: false,
                scale: QUALITY_HEIGHT[request.quality] ?? null,
                maxBitrate: QUALITY_BITRATE[request.quality] ?? null,
              },
          picture: dovi ? 'dovi' : 'none',
          reason: videoReason,
        }
      : null,
    audio: audio
      ? {
          track: audio.index,
          where: direct
            ? 'page-original'
            : copyAudio
              ? 'server-copy'
              : binaural
                ? 'server-render'
                : 'server-convert',
          pageRenders,
          convert: copyAudio || binaural ? null : convertOf(audio, caps),
          render: binaural
            ? {
                binaural: true,
                // The listener's headphone mode ('near' or 'far'; null: as mixed).
                mode: Object.hasOwn(RENDER_MODES, caps.binauralMode ?? '')
                  ? caps.binauralMode
                  : null,
                // Already stereo for headphones: FLAC where the browser plays it, else AAC.
                ...(caps.lossless === true
                  ? { codec: 'flac', bitrate: null }
                  : { codec: 'aac', bitrate: '192k' }),
              }
            : null,
          reason: audioReason,
        }
      : null,
    subtitle: subtitle
      ? {
          track: subtitle.index,
          where: burn ? 'server-burn' : 'page',
          format,
        }
      : null,
  };
}

/**
 * A server conversion's output. Surround stays surround where wanted (a surround output, or
 * the player's virtual surround for headphones): lossless FLAC at the source's layout, up to
 * 7.1, where the browser plays it, else 5.1 AAC (AAC's own 7.1 places its extra pair as front
 * wides). The browser downmixes to the speakers there are.
 */
function convertOf(audio, caps) {
  const channels = audio.channels ?? 2;
  const surround = caps.surround === true && channels > 2;
  const lossless = surround && caps.lossless === true;
  const layout = !surround
    ? 'stereo'
    : lossless && channels > 6
      ? '7.1'
      : '5.1';
  return {
    codec: lossless ? 'flac' : 'aac',
    layout,
    channels: { stereo: 2, 5.1: 6, 7.1: 8 }[layout],
    bitrate: lossless ? null : surround ? '384k' : '192k',
  };
}

/** The tracks a spec names, from the media. */
export function tracksOf(meta, spec) {
  const find = (s) =>
    s ? (meta.tracks.find((t) => t.index === s.track) ?? null) : null;
  return {
    video: find(spec.video),
    audio: find(spec.audio),
    subtitle: find(spec.subtitle),
  };
}

/**
 * The spec's job, for /health, the capacity count and the player: the original file
 * (`direct`), both streams copied (`remux`), only the audio converted (`audio`), or the video
 * converted (`video`).
 * @returns {'direct'|'remux'|'audio'|'video'}
 */
export function modeOf(spec) {
  if (spec.video?.where === 'page-original') return 'direct';
  if (!spec.video || spec.video.where === 'server-encode') return 'video';
  const where = spec.audio?.where;
  return !spec.audio || where === 'server-copy' || where === 'page-original'
    ? 'remux'
    : 'audio';
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
  // The spec decided for this job (with what the transcoder knows), else from the request.
  const spec = options.spec ?? playbackSpec(meta, request, options.inputs);
  const { video, audio, subtitle } = tracksOf(meta, spec);
  const copyVideo = spec.video.where !== 'server-encode';
  const burn = spec.subtitle?.where === 'server-burn';
  const binaural = spec.audio?.where === 'server-render';
  const copyAudio =
    spec.audio?.where === 'server-copy' ||
    spec.audio?.where === 'page-original';
  const drawsDoviHere = spec.video.picture === 'dovi';
  const offset =
    Math.floor(Math.max(0, request.positionMs ?? 0) / 1000 / 4) * 4;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const hw = encoder === 'vaapi' && !copyVideo && !burn && !video?.hdr;
  if (hw)
    args.push(
      '-vaapi_device',
      process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128'
    );
  const gpuTonemap =
    encoder === 'nvidia' &&
    (options.tonemap ?? 'gpu') === 'gpu' &&
    !copyVideo &&
    !!video?.hdr;
  // Frames stay on the GPU from NVDEC to NVENC. Not with burn-in (its
  // overlay is on the CPU) nor a rotated picture (FFmpeg's autorotate is on
  // the CPU), and only with HDR tone-mapped on the GPU too.
  const gpuDecode =
    encoder === 'nvidia' &&
    (options.decode ?? 'gpu') === 'gpu' &&
    !copyVideo &&
    !burn &&
    !video?.rotation &&
    nvdecDecodes(video) &&
    (!video?.hdr || gpuTonemap);
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
  if (!burn) args.push('-ss', String(offset));
  // With the video copied, the audio starts at the same keyframe rather than
  // at the seek, as Plex does: no stretch of picture without sound.
  if (copyVideo) args.push('-noaccurate_seek');
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
  if (binaural)
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
  if (burn) {
    // FFmpeg's subtitle decoder feeds an overlay without
    // interpolating an untrusted URL into a filter expression.
    const sub = meta.tracks
      .filter((t) => t.type === 'subtitle')
      .findIndex((t) => t.index === subtitle.index);
    if (['ass', 'ssa'].includes(subtitle.codec)) {
      // The input is a server-generated, URL-safe source handle.
      filters.push(
        `subtitles=filename='${input.replace(/[:\\']/g, '\\$&')}':si=${sub}`
      );
    }
  }
  if (burn) args.push('-ss', String(offset));
  args.push(
    '-map',
    burn && !['ass', 'ssa'].includes(subtitle.codec)
      ? '[vsub]'
      : `0:${video.index}`
  );
  if (audio) args.push('-map', binaural ? '1:a' : `0:${audio.index}`);
  if (copyVideo) {
    args.push('-c:v', 'copy');
    // Browsers and Safari's player expect HEVC tagged hvc1.
    if (video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    const encode = spec.video.encode;
    const height = encode.scale;
    const hdr = encode.tonemap === 'server';
    if (gpuDecode) {
      // Jellyfin's GetNvidiaVidFiltersPrefered with NVDEC and NVENC.
      const size = height
        ? `w=-2:h='trunc(min(${height},ih)/2)*2'`
        : `w='trunc(iw/2)*2':h='trunc(ih/2)*2'`;
      // HEVC range extensions (4:4:4, 12-bit) go to tonemap_cuda as P010.
      const rext = !['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(
        video.pixelFormat
      );
      filters.push(
        hdr ? hdrParams(video) : SDR_PARAMS,
        `scale_cuda=${size}${hdr ? (rext ? ':format=p010' : '') : ':format=yuv420p'}`
      );
      if (hdr) filters.push(`tonemap_cuda=${TONEMAP}:format=yuv420p`);
    } else {
      if (hdr) filters.push(hdrParams(video));
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
    if (burn && !['ass', 'ssa'].includes(subtitle.codec)) {
      args.push(
        '-filter_complex',
        `[0:${video.index}][0:${subtitle.index}]overlay,${filters.join(',')}[vsub]`
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
    if (encode.maxBitrate) {
      // A buffer of two seconds at the cap.
      const bufsize = `${parseInt(encode.maxBitrate, 10) * 2}M`;
      args.push(
        '-b:v',
        encode.maxBitrate,
        '-maxrate',
        encode.maxBitrate,
        '-bufsize',
        bufsize
      );
    }
    args.push(
      '-force_key_frames',
      'expr:gte(t,n_forced*4)',
      '-sc_threshold',
      '0'
    );
  }
  if (audio) args.push('-c:a', copyAudio ? 'copy' : 'aac');
  // TrueHD in MP4 (mlpa) is behind FFmpeg's experimental flag.
  if (copyAudio && audio.codec === 'truehd') {
    args.push('-strict', 'experimental');
    // That flag also has the MP4 muxer write a copied Dolby Vision stream's configuration box
    // (dvcC), which it otherwise leaves out, and Chrome refuses Dolby Vision through Media Source
    // unless it's encrypted ("MSE playback of DolbyVision is only supported via platform
    // decryptor"). Without the Dolby Vision metadata it's the HDR10 stream that plays without
    // the flag.
    // Where the player draws Dolby Vision it needs the RPUs, and it drops the box itself.
    if (copyVideo && video?.dovi && !drawsDoviHere)
      args.push('-bsf:v', 'dovi_rpu=strip=1');
  }
  // A conversion's layout: continuous where the source's audio has gaps, and downmixed without
  // clipping, as Plex does (a plain -ac 2 peaks over 0 dBFS). A binaural render is stereo
  // already.
  const convert = spec.audio?.convert;
  const out = convert ?? spec.audio?.render;
  if (convert)
    args.push(
      '-af',
      `aresample=async=1:ochl=${convert.layout}:rematrix_maxval=1`,
      '-ac',
      String(convert.channels)
    );
  if (out)
    args.push(
      ...(out.codec === 'flac'
        ? // 24-bit, as TrueHD and DTS-HD MA decode to.
          ['-c:a', 'flac', '-sample_fmt', 's32']
        : ['-b:a', out.bitrate])
    );
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
    audio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
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
    video?.hdr && !copyVideo ? (gpuTonemap ? 'gpu' : 'cpu') : null;
  const decode = copyVideo ? null : gpuDecode ? 'gpu' : 'cpu';
  return { args, offsetMs: offset * 1000, offset, spec, tonemap, decode };
}

/** How long FFmpeg keeps reconnecting to a source: past an AIOStreams pod's restart (50 s). */
export const RECONNECT_DELAY_MAX_S = 120;

/** The DASH output every stream job writes: one stream, its own segments, source timestamps. */
function dashOutput(kind, output) {
  return [
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
    `id=0,streams=${kind === 'video' ? 'v' : 'a'}`,
    // As for the combined command: the source's timestamps in each fragment (tfdt), no sidx.
    '-format_options',
    'movflags=+frag_discont+skip_sidx',
    '-init_seg_name',
    'init-$RepresentationID$.m4s',
    '-media_seg_name',
    'chunk-$RepresentationID$-$Number%05d$.m4s',
    `${output}/manifest.mpd`,
  ];
}
const reconnect = (input) =>
  /^https?:/.test(input)
    ? [
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_on_network_error',
        '1',
        '-reconnect_delay_max',
        String(RECONNECT_DELAY_MAX_S),
      ]
    : [];
const TIMESTAMPS = [
  '-copyts',
  '-avoid_negative_ts',
  'disabled',
  '-start_at_zero',
];

/**
 * One stream's conversion: a video job (the picture, copied or encoded, with any burned-in
 * subtitle) or an audio job (the track copied, converted, or rendered binaural by atmos-render on
 * stdin). Each writes its own DASH stream on the source's timestamps, so the two play together in
 * one manifest. Built from the same choices as `ffmpegArgs`, the command they replace.
 *
 * `options.positionMs` is where the job starts. For a video job, `decode` and `tonemap` as for
 * `ffmpegArgs`. For a binaural audio job, `audioStart` (seconds): the source timestamp of the
 * first audio packet, where the rendered audio is placed (`-output_ts_offset`: FFmpeg ignores
 * `-itsoffset` on a raw pipe, so rendered audio would start at 0). `videoCopied` says the video
 * job copies the picture: the audio then starts at the same keyframe (`-noaccurate_seek`).
 */
export function streamArgs(
  kind,
  input,
  meta,
  spec,
  output,
  encoder = 'cpu',
  options = {}
) {
  const { video, audio, subtitle } = tracksOf(meta, spec);
  const offset =
    Math.floor(Math.max(0, options.positionMs ?? 0) / 1000 / 4) * 4;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (kind === 'audio') {
    const binaural = spec.audio.where === 'server-render';
    const copyAudio =
      spec.audio.where === 'server-copy' ||
      spec.audio.where === 'page-original';
    if (binaural)
      args.push(
        '-f',
        'f32le',
        '-ar',
        '48000',
        '-ch_layout',
        'stereo',
        '-i',
        'pipe:0',
        '-map',
        '0:a'
      );
    else {
      args.push('-ss', String(offset));
      if (options.videoCopied) args.push('-noaccurate_seek');
      args.push(...reconnect(input), '-i', input, '-map', `0:${audio.index}`);
    }
    args.push('-vn', '-c:a', copyAudio ? 'copy' : 'aac');
    if (copyAudio && audio.codec === 'truehd')
      args.push('-strict', 'experimental');
    const convert = spec.audio.convert;
    const out = convert ?? spec.audio.render;
    if (convert)
      args.push(
        '-af',
        `aresample=async=1:ochl=${convert.layout}:rematrix_maxval=1`,
        '-ac',
        String(convert.channels)
      );
    if (out)
      args.push(
        ...(out.codec === 'flac'
          ? ['-c:a', 'flac', '-sample_fmt', 's32']
          : ['-b:a', out.bitrate])
      );
    args.push('-sn', '-map_metadata', '-1');
    if (binaural)
      args.push(
        '-copyts',
        '-avoid_negative_ts',
        'disabled',
        '-output_ts_offset',
        String(options.audioStart ?? offset)
      );
    else args.push(...TIMESTAMPS);
    args.push(...dashOutput('audio', output));
    return { args, offsetMs: offset * 1000, offset };
  }
  const copyVideo = spec.video.where !== 'server-encode';
  const burn = spec.subtitle?.where === 'server-burn';
  const hw = encoder === 'vaapi' && !copyVideo && !burn && !video?.hdr;
  if (hw)
    args.push(
      '-vaapi_device',
      process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128'
    );
  const gpuTonemap =
    encoder === 'nvidia' &&
    (options.tonemap ?? 'gpu') === 'gpu' &&
    !copyVideo &&
    !!video?.hdr;
  const gpuDecode =
    encoder === 'nvidia' &&
    (options.decode ?? 'gpu') === 'gpu' &&
    !copyVideo &&
    !burn &&
    !video?.rotation &&
    nvdecDecodes(video) &&
    (!video?.hdr || gpuTonemap);
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
  if (!burn) args.push('-ss', String(offset));
  if (copyVideo) args.push('-noaccurate_seek');
  args.push(...reconnect(input), '-i', input);
  const filters = [];
  if (burn && ['ass', 'ssa'].includes(subtitle.codec)) {
    const sub = meta.tracks
      .filter((t) => t.type === 'subtitle')
      .findIndex((t) => t.index === subtitle.index);
    filters.push(
      `subtitles=filename='${input.replace(/[:\\']/g, '\\$&')}':si=${sub}`
    );
  }
  if (burn) args.push('-ss', String(offset));
  args.push(
    '-map',
    burn && !['ass', 'ssa'].includes(subtitle.codec)
      ? '[vsub]'
      : `0:${video.index}`
  );
  if (copyVideo) {
    args.push('-c:v', 'copy');
    if (video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    const encode = spec.video.encode;
    const height = encode.scale;
    const hdr = encode.tonemap === 'server';
    if (gpuDecode) {
      const size = height
        ? `w=-2:h='trunc(min(${height},ih)/2)*2'`
        : `w='trunc(iw/2)*2':h='trunc(ih/2)*2'`;
      const rext = !['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(
        video.pixelFormat
      );
      filters.push(
        hdr ? hdrParams(video) : SDR_PARAMS,
        `scale_cuda=${size}${hdr ? (rext ? ':format=p010' : '') : ':format=yuv420p'}`
      );
      if (hdr) filters.push(`tonemap_cuda=${TONEMAP}:format=yuv420p`);
    } else {
      if (hdr) filters.push(hdrParams(video));
      if (height) filters.push(`scale=w=-2:h='min(${height},ih)'`);
      if (hdr)
        filters.push(
          gpuTonemap
            ? `format=p010le,hwupload,tonemap_cuda=${TONEMAP}:format=yuv420p,hwdownload`
            : `tonemapx=${TONEMAP}:format=yuv420p`
        );
      filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p');
    }
    if (hw) filters.push('hwupload');
    if (burn && !['ass', 'ssa'].includes(subtitle.codec))
      args.push(
        '-filter_complex',
        `[0:${video.index}][0:${subtitle.index}]overlay,${filters.join(',')}[vsub]`
      );
    else if (filters.length) args.push('-vf', filters.join(','));
    const codec = hw
      ? 'h264_vaapi'
      : encoder === 'nvidia'
        ? 'h264_nvenc'
        : 'libx264';
    args.push('-c:v', codec);
    if (codec === 'libx264') args.push('-preset', 'veryfast', '-crf', '20');
    if (codec === 'h264_nvenc')
      args.push('-preset', 'p4', '-cq', '20', '-forced-idr', '1');
    if (codec === 'h264_vaapi' && !height) args.push('-qp', '20');
    if (encode.maxBitrate) {
      const bufsize = `${parseInt(encode.maxBitrate, 10) * 2}M`;
      args.push(
        '-b:v',
        encode.maxBitrate,
        '-maxrate',
        encode.maxBitrate,
        '-bufsize',
        bufsize
      );
    }
    args.push(
      '-force_key_frames',
      'expr:gte(t,n_forced*4)',
      '-sc_threshold',
      '0'
    );
  }
  args.push('-an', '-sn', '-map_metadata', '-1', ...TIMESTAMPS);
  args.push(...dashOutput('video', output));
  const tonemap =
    video?.hdr && !copyVideo ? (gpuTonemap ? 'gpu' : 'cpu') : null;
  const decode = copyVideo ? null : gpuDecode ? 'gpu' : 'cpu';
  // Whether this command uses the GPU, which decides whether a failure falls back to the CPU.
  const gpu = hw || encoder === 'nvidia' ? !copyVideo : false;
  return { args, offsetMs: offset * 1000, offset, tonemap, decode, gpu };
}

/** The boxes in an ISO BMFF byte range: [type, start of content, end]. */
function* boxes(data, from = 0, to = data.length) {
  let at = from;
  while (at + 8 <= to) {
    let size = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
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
    // An hvcC too short for its fixed fields (13 bytes) gives nothing to build from.
    if (!c || c[2] - c[1] < 13) return null;
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
    if (!c || c[2] - c[1] < 4) return null;
    return `${type}.${[1, 2, 3]
      .map((i) => init[c[1] + i].toString(16).padStart(2, '0'))
      .join('')}`;
  }
  if (type === 'av01') {
    const c = config('av1C');
    if (!c || c[2] - c[1] < 3) return null;
    const p = init[c[1] + 1],
      q = init[c[1] + 2];
    const depth = q & 0x40 ? (q & 0x20 ? 12 : 10) : 8;
    return `av01.${p >> 5}.${String(p & 0x1f).padStart(2, '0')}${q & 0x80 ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
  }
  if (type === 'vp09') {
    const c = config('vpcC');
    if (!c || c[2] - c[1] < 7) return null;
    // A full box: version and flags first.
    const [profile, level, bits] = [4, 5, 6].map((i) => init[c[1] + i]);
    return `vp09.${[profile, level, bits >> 4]
      .map((n) => String(n).padStart(2, '0'))
      .join('.')}`;
  }
  return null;
}
/**
 * An init segment's boxes, as "type:size" down the path to its sample entry and that entry's
 * own boxes: what a codec string couldn't be built from, for the log (no contents).
 */
export function initLayout(init) {
  const out = [];
  const walk = (from, to, depth) => {
    for (const [type, start, end] of boxes(init, from, to)) {
      out.push(`${'  '.repeat(depth)}${type}:${end - start}`);
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type))
        walk(start, end, depth + 1);
      else if (type === 'stsd') walk(start + 8, end, depth + 1);
      // a visual sample entry: its configuration boxes after its 78 bytes of fields
      else if (depth === 6) walk(start + 78, end, depth + 1);
    }
  };
  walk(0, init.length, 0);
  return out.join(' ');
}
/** Whether every stream in the manifest has a segment written. */
/** Milliseconds written, from FFmpeg's `-progress` line `out_time_us=…`; null for others and "N/A". */
export function outTimeMs(line) {
  if (!line.startsWith('out_time_us=')) return null;
  const us = Number(line.slice(12));
  return line.length > 12 && Number.isFinite(us) ? us / 1000 : null;
}
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
/**
 * The manifest's codec string for an audio track copied as it is, where FFmpeg writes none:
 * TrueHD's, and DTS's (MP4's object type for it, as FFmpeg 6 writes).
 */
const COPIED_CODECS = { truehd: 'mlpa', dts: 'mp4a.a9' };
export function audioCodec(meta, spec) {
  const where = spec.audio?.where;
  const copied = where === 'server-copy' || where === 'page-original';
  return (copied && COPIED_CODECS[tracksOf(meta, spec).audio?.codec]) || null;
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

/**
 * A stream job's segments, from the manifest FFmpeg writes for it (one SegmentTemplate with a
 * SegmentTimeline): each segment's number, start and duration in the timescale's units.
 */
export function parseTimeline(mpd) {
  const template =
    /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(mpd);
  if (!template) return null;
  const timescale = Number(/timescale="(\d+)"/.exec(template[1])?.[1] ?? 1);
  let number = Number(/startNumber="(\d+)"/.exec(template[1])?.[1] ?? 1);
  const segments = [];
  let t = 0;
  for (const [, attrs] of template[2].matchAll(/<S\b([^>]*)\/>/g)) {
    const at = /\bt="(\d+)"/.exec(attrs);
    if (at) t = Number(at[1]);
    const d = Number(/\bd="(\d+)"/.exec(attrs)?.[1]);
    const repeats = Number(/\br="(-?\d+)"/.exec(attrs)?.[1] ?? 0);
    if (!(d > 0)) continue;
    for (let i = 0; i <= Math.max(0, repeats); i++) {
      segments.push({ number: number++, t, d });
      t += d;
    }
  }
  return { timescale, segments };
}

/** A SegmentTimeline for `segments`: `t=` on the first and after any gap, equal runs as `r=`. */
export function timelineOf(segments) {
  const out = [];
  let run = null;
  let next = null;
  for (const s of segments) {
    if (run && s.t === next && s.d === run.d) run.r++;
    else {
      run = { t: s.t === next ? null : s.t, d: s.d, r: 0 };
      out.push(run);
    }
    next = s.t + s.d;
  }
  return out
    .map(
      (r) =>
        `<S${r.t == null ? '' : ` t="${r.t}"`} d="${r.d}"${r.r ? ` r="${r.r}"` : ''} />`
    )
    .join('\n\t\t\t\t\t\t');
}

/**
 * One viewer's manifest, from its stream jobs' (a video job, and an audio job when the audio is
 * converted): each job's AdaptationSet, with segments from `firstKept` on (the window's earlier
 * ones are deleted), URLs under the job's id, and the codec strings filled in. The MPD itself is
 * a running job's (dynamic, refreshed by the player), or once every job has finished, static
 * with the source's full duration. A dynamic one says the window: `timeShiftBufferDepth`.
 *
 * `parts`: [{ kind: 'video'|'audio', id, mpd, firstKept, codec }].
 */
/** From the first kept segment's start to the last segment's end, over every part, plus one segment. */
function keptSpanMs(parts) {
  let first = Infinity;
  let last = -Infinity;
  let longest = 0;
  for (const part of parts) {
    const timeline = parseTimeline(part.mpd);
    if (!timeline) continue;
    const kept = timeline.segments.filter(
      (s) => s.number >= (part.firstKept ?? 1)
    );
    if (!kept.length) continue;
    const ms = 1000 / timeline.timescale;
    first = Math.min(first, kept[0].t * ms);
    const end = kept.at(-1);
    last = Math.max(last, (end.t + end.d) * ms);
    for (const s of kept) longest = Math.max(longest, s.d * ms);
  }
  return last > first ? last - first + longest : 0;
}

export function composeManifest(parts, { durationMs, windowMs }) {
  const running = parts.find((p) => /type="dynamic"/.test(p.mpd));
  const header = (running ?? parts[0]).mpd;
  let head = header.slice(0, header.search(/<AdaptationSet\b/));
  if (running) {
    // Players seek only within timeShiftBufferDepth of the live edge, and the edge is the last
    // segment written, which runs ahead of the viewer: the depth covers every segment kept.
    head = head.replace(/\s+timeShiftBufferDepth="[^"]*"/, '');
    head = head.replace(
      /<MPD\b/,
      `<MPD timeShiftBufferDepth="PT${Math.ceil(Math.max(windowMs, keptSpanMs(parts)) / 1000)}S"`
    );
  } else head = withFullDuration(head, durationMs);
  const sets = parts.map((part, i) => {
    let set =
      /<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/.exec(part.mpd)?.[0] ?? '';
    const timeline = parseTimeline(part.mpd);
    const kept = (timeline?.segments ?? []).filter(
      (s) => s.number >= (part.firstKept ?? 1)
    );
    set = set
      .replace(/(<AdaptationSet\b[^>]*\bid=")[^"]*(")/, `$1${i}$2`)
      .replace(/(<Representation\b[^>]*\bid=")[^"]*(")/, `$1${i}$2`)
      .replace(
        /<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/,
        `<SegmentTemplate timescale="${timeline?.timescale ?? 1}" initialization="${part.id}/init-0.m4s" media="${part.id}/chunk-0-$Number%05d$.m4s" startNumber="${kept[0]?.number ?? part.firstKept ?? 1}">\n\t\t\t\t\t<SegmentTimeline>\n\t\t\t\t\t\t${timelineOf(kept)}\n\t\t\t\t\t</SegmentTimeline>\n\t\t\t\t</SegmentTemplate>`
      );
    return part.kind === 'video'
      ? withVideoCodec(set, part.codec)
      : withAudioCodec(set, part.codec);
  });
  return `${head}${sets.join('\n\t\t')}\n\t</Period>\n</MPD>\n`;
}
