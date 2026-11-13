/*
 * Every combination the playback decision is pinned on: sources (video, audio and subtitle
 * kinds) × what the player can do × quality, retry and encoder. `record()` gives, for each, the
 * policy and every argument list the transcoder would run. `spec-matrix.json` holds what the
 * code produced before the playback spec replaced its flags; the test compares against it, so
 * the decision can change shape without changing what runs.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import * as media from './media.mjs';

const VIDEOS = {
  h264: { codec: 'h264', profile: 'High', pixelFormat: 'yuv420p' },
  hevc10: { codec: 'hevc', profile: 'Main 10', pixelFormat: 'yuv420p10le' },
  hdr10: {
    codec: 'hevc',
    profile: 'Main 10',
    pixelFormat: 'yuv420p10le',
    transfer: 'smpte2084',
    hdr: true,
  },
  hlg: {
    codec: 'hevc',
    profile: 'Main 10',
    pixelFormat: 'yuv420p10le',
    transfer: 'arib-std-b67',
    hdr: true,
  },
  dv5: {
    codec: 'hevc',
    profile: 'Main 10',
    pixelFormat: 'yuv420p10le',
    hdr: true,
    dovi: { profile: 5, compatibility: 0 },
  },
  dv8: {
    codec: 'hevc',
    profile: 'Main 10',
    pixelFormat: 'yuv420p10le',
    transfer: 'smpte2084',
    hdr: true,
    dovi: { profile: 8, compatibility: 1 },
  },
  rotated: {
    codec: 'h264',
    profile: 'High',
    pixelFormat: 'yuv420p',
    rotation: 90,
  },
  hi444: { codec: 'hevc', profile: 'Rext', pixelFormat: 'yuv444p10le' },
};
const AUDIOS = {
  truehd: { codec: 'truehd', channels: 8, sampleRate: 48000 },
  truehd96: { codec: 'truehd', channels: 8, sampleRate: 96000 },
  eac3: { codec: 'eac3', channels: 6, sampleRate: 48000 },
  ac3: { codec: 'ac3', channels: 6, sampleRate: 48000 },
  dts: { codec: 'dts', channels: 6, sampleRate: 48000 },
  aac: { codec: 'aac', channels: 2, sampleRate: 48000 },
  flac71: { codec: 'flac', channels: 8, sampleRate: 48000 },
  none: null,
};
const SUBTITLES = {
  none: null,
  srt: 'subrip',
  ass: 'ass',
  pgs: 'hdmv_pgs_subtitle',
  vobsub: 'dvd_subtitle',
};
const PLAYERS = {
  // Chrome on an SDR screen: HEVC decodes, no E-AC-3, page renders Atmos.
  chromeSdr: {
    video: true,
    audio: false,
    container: false,
    hdr: false,
    surround: true,
    lossless: true,
    clientBinaural: ['truehd', 'eac3', 'ac3', 'dts'],
    subtitles: ['ass', 'pgs'],
  },
  // Chrome on an HDR screen that draws Dolby Vision.
  chromeHdr: {
    video: true,
    audio: false,
    container: false,
    hdr: true,
    surround: true,
    lossless: true,
    clientBinaural: ['truehd', 'eac3', 'ac3', 'dts'],
    picture: ['dovi'],
    display: 'hdr',
    demux: [],
    subtitles: ['ass', 'pgs'],
  },
  // Edge on an HDR screen as it is now: plays E-AC-3 natively, and renders it here too.
  edgeToday: {
    video: true,
    audio: true,
    container: false,
    hdr: true,
    surround: true,
    lossless: true,
    clientBinaural: ['truehd', 'eac3', 'ac3', 'dts'],
    picture: ['dovi'],
    display: 'hdr',
    demux: [],
    subtitles: ['ass', 'pgs'],
  },
  // Edge on an HDR screen before ac991ea: plays E-AC-3 natively, no page renderer for it.
  edgeHdr: {
    video: true,
    audio: true,
    container: false,
    hdr: true,
    surround: true,
    lossless: true,
    clientBinaural: ['truehd', 'dts'],
    picture: ['dovi'],
    subtitles: ['ass', 'pgs'],
  },
  // Safari: plays the file as it is where it can, no WebAssembly renderers.
  safariDirect: {
    video: true,
    audio: true,
    container: true,
    hdr: true,
    surround: true,
    lossless: true,
    subtitles: [],
  },
  // Surround as 5.1 AAC only (no FLAC), and only ASS drawn: PGS is burned in.
  aac51: {
    video: true,
    audio: false,
    container: false,
    hdr: false,
    surround: true,
    lossless: false,
    subtitles: ['ass'],
  },
  // A browser that decodes nothing here (no HEVC, stereo output only).
  weak: {
    video: false,
    audio: false,
    container: false,
    hdr: false,
    surround: false,
    lossless: false,
    subtitles: [],
  },
};
const HEADPHONES = {
  off: {},
  on: { binaural: true },
  near: { binaural: true, binauralMode: 'near' },
  far: { binaural: true, binauralMode: 'far' },
};
const REQUESTS = {
  original: { quality: 'original' },
  q720: { quality: '720p' },
  q1080: { quality: '1080p' },
  force: { quality: 'original', force: true },
};
const ENCODERS = [
  ['cpu', {}],
  ['nvidia', {}],
  ['nvidia', { decode: 'cpu', tonemap: 'gpu' }],
  ['nvidia', { decode: 'cpu', tonemap: 'cpu' }],
  ['vaapi', {}],
];

function meta(video, audio, subtitle) {
  const tracks = [
    {
      index: 0,
      type: 'video',
      width: 3840,
      height: 2160,
      frameRate: 23.976,
      rotation: 0,
      ...video,
    },
  ];
  if (audio) tracks.push({ index: 1, type: 'audio', default: true, ...audio });
  // A second audio track, so choosing one that isn't first is covered.
  tracks.push({
    index: 2,
    type: 'audio',
    codec: 'aac',
    channels: 2,
    sampleRate: 48000,
  });
  if (subtitle) tracks.push({ index: 3, type: 'subtitle', codec: subtitle });
  return {
    durationMs: 7_200_000,
    container: 'matroska,webm',
    bitrate: 60_000_000,
    tracks,
    fonts: [],
    chapters: [],
  };
}

export function* cases() {
  for (const [v, video] of Object.entries(VIDEOS))
    for (const [a, audio] of Object.entries(AUDIOS))
      for (const [s, subtitle] of Object.entries(SUBTITLES))
        for (const [p, player] of Object.entries(PLAYERS))
          for (const [h, phones] of Object.entries(HEADPHONES))
            for (const [r, req] of Object.entries(REQUESTS))
              for (const track of audio ? [undefined, 2] : [undefined]) {
                const request = {
                  ...req,
                  positionMs: 1_668_993,
                  ...(track !== undefined ? { audio: track } : {}),
                  ...(subtitle ? { subtitle: 3 } : {}),
                  capabilities: { ...player, ...phones },
                };
                yield {
                  name: [v, a, s, p, h, r, track ?? 'default'].join('/'),
                  meta: meta(video, audio, subtitle),
                  request,
                };
              }
}

/**
 * What a spec means for the conversion, as plain data: the same fields the decision had as
 * flags before the spec, so records made before and after it compare.
 */
function viewOf(meta, spec) {
  const where = spec.audio?.where;
  return {
    mode: media.modeOf(spec),
    videoReason: spec.video?.reason ?? null,
    audioReason: spec.audio?.reason ?? null,
    burn: spec.subtitle?.where === 'server-burn',
    copyVideo: !!spec.video && spec.video.where !== 'server-encode',
    copyAudio: where === 'server-copy' || where === 'page-original',
    binaural: where === 'server-render',
    clientBinaural: !!spec.audio?.pageRenders,
    binauralMode: spec.audio?.render?.mode ?? null,
    dovi: spec.video?.picture === 'dovi',
    audio: spec.audio?.track ?? null,
    subtitle: spec.subtitle?.track ?? null,
    audioCodec: media.audioCodec(meta, spec),
  };
}

/**
 * The same for the code before the spec (ac991ea's media.mjs, which the pin was made from):
 * its `select()` flags, and its argument functions. It knew Dolby Vision drawn by the page as
 * the `dovi` capability flag, which `picture: ['dovi']` replaced.
 */
function before(meta, request) {
  const caps = request.capabilities ?? {};
  const asked = caps.picture?.includes('dovi')
    ? { ...request, capabilities: { ...caps, dovi: true } }
    : request;
  const policy = media.select(meta, asked);
  return {
    request: asked,
    view: {
      mode: policy.mode,
      videoReason: policy.videoReason,
      audioReason: policy.audioReason,
      burn: policy.burn,
      copyVideo: policy.copyVideo,
      copyAudio: policy.copyAudio,
      binaural: policy.binaural,
      clientBinaural: policy.clientBinaural,
      binauralMode: policy.binauralMode,
      dovi: policy.dovi,
      audio: policy.audio?.index ?? null,
      subtitle: policy.subtitle?.index ?? null,
      audioCodec: media.audioCodec(policy),
    },
    demux: () => media.demuxArgs('in', policy, 1668),
    renderer: () => media.rendererArgs(policy),
  };
}

/** The decision and every argument list for one case, as plain data. */
export function record({ meta, request }) {
  let decided;
  try {
    if (media.playbackSpec) {
      const spec = media.playbackSpec(meta, request);
      decided = {
        request,
        view: viewOf(meta, spec),
        demux: () => media.demuxArgs('in', meta, spec, 1668),
        renderer: () => media.rendererArgs(meta, spec),
      };
    } else decided = before(meta, request);
  } catch (error) {
    return { error: error.message };
  }
  const { view } = decided;
  if (view.mode === 'direct') return { policy: view };
  const runs = {};
  for (const [encoder, options] of ENCODERS) {
    const out = media.ffmpegArgs('in', meta, decided.request, 'out', encoder, {
      ...options,
      ...(view.binaural ? { audioStart: 1667.995 } : {}),
    });
    runs[`${encoder}:${options.decode ?? '-'}:${options.tonemap ?? '-'}`] = {
      args: out.args,
      offsetMs: out.offsetMs,
      tonemap: out.tonemap,
      decode: out.decode,
    };
  }
  return {
    policy: view,
    runs,
    ...(view.binaural
      ? { demux: decided.demux(), renderer: decided.renderer() }
      : {}),
  };
}

/** A case's record as a short digest: equal records, equal digests. */
export async function digestOf(record) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(JSON.stringify(record))
    .digest('base64url')
    .slice(0, 22);
}

/** The pinned digests, stored compressed: name → digest. */
export function readPin(buffer) {
  return JSON.parse(gunzipSync(buffer).toString('utf8'));
}
export function writePin(pin) {
  return gzipSync(JSON.stringify(pin));
}
