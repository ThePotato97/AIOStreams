/* eslint-disable lingui/no-unlocalized-strings -- MIME strings are browser API inputs, not UI text. */
import type {
  GuestCapabilities,
  GuestMedia,
  GuestTrack,
} from '@aiostreams/core';
import { canRender } from './subtitle-renderer';
import {
  CLIENT_BINAURAL_CODECS,
  clientBinauralSupported,
} from '../playback/binaural/transmuxer';
/** ffprobe reports -99 (or nothing) when a stream doesn't declare its level. */
const knownLevel = (level: number | undefined, fallback: number) =>
  level != null && Number.isInteger(level) && level > 0 ? level : fallback;

/** The RFC 6381 codec string the browser is asked about. */
export function codec(track: GuestTrack): string | null {
  switch (track.codec) {
    case 'h264': {
      const profile = track.profile?.toLowerCase() ?? '';
      // profile_idc in hex: High 4:4:4 244, High 4:2:2 122, High 10 110.
      const prefix = profile.includes('4:4:4')
        ? 'f400'
        : profile.includes('4:2:2')
          ? '7a00'
          : profile.includes('high 10')
            ? '6e00'
            : profile.includes('high')
              ? '6400'
              : profile.includes('main')
                ? '4d40'
                : '42e0';
      // Level 4.0 when unknown: an invalid string such as "avc1.6400-63"
      // reads as unsupported and forces a needless video conversion.
      const level = knownLevel(track.level, 40);
      return `avc1.${prefix}${level.toString(16).padStart(2, '0')}`;
    }
    case 'hevc': {
      // Main 10 is a different decoder profile; asking about Main would
      // report support the browser may not have. Level is 30 x the level
      // number (153 = 5.1).
      const level = knownLevel(track.level, 153);
      return /10/.test(track.profile ?? '')
        ? `hvc1.2.4.L${level}.B0`
        : `hvc1.1.6.L${level}.B0`;
    }
    case 'vp9':
      return 'vp09.00.41.08';
    case 'vp8':
      return 'vp8';
    case 'av1':
      return 'av01.0.08M.08';
    case 'aac':
      return track.profile?.includes('HE') ? 'mp4a.40.5' : 'mp4a.40.2';
    case 'mp3':
      return 'mp3';
    case 'opus':
      return 'opus';
    case 'vorbis':
      return 'vorbis';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    case 'flac':
      return 'flac';
    default:
      return null;
  }
}
export async function browserCapabilities(
  media: GuestMedia,
  audioIndex?: number,
  /** Surround is rendered for headphones in the page. */
  headphones = false
): Promise<GuestCapabilities> {
  const el = document.createElement('video');
  const video = media.tracks.find((t) => t.type === 'video');
  const audio =
    media.tracks.find((t) => t.type === 'audio' && t.index === audioIndex) ??
    media.tracks.find((t) => t.type === 'audio' && t.default) ??
    media.tracks.find((t) => t.type === 'audio');
  const vc = video && codec(video),
    ac = audio && codec(audio);
  const mime = media.container.includes('webm')
    ? 'video/webm'
    : media.container.includes('matroska')
      ? 'video/x-matroska'
      : media.container.includes('mpegts')
        ? 'video/mp2t'
        : media.container.includes('mov') || media.container.includes('mp4')
          ? 'video/mp4'
          : '';
  const videoType = vc
    ? `video/${video?.codec === 'vp8' || video?.codec === 'vp9' ? 'webm' : 'mp4'}; codecs="${vc}"`
    : '';
  const audioType = ac
    ? `audio/${audio?.codec === 'opus' || audio?.codec === 'vorbis' ? 'webm' : 'mp4'}; codecs="${ac}"`
    : '';
  const supports = (type: string) =>
    !!type &&
    (!!el.canPlayType(type) ||
      (typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported(type)));
  let videoSupport = supports(videoType),
    audioSupport = !audio || supports(audioType);
  // Whether HDR video plays as it is: the browser says so itself. The screen
  // being in HDR mode is only the answer where the browser can't be asked.
  const hdrScreen = () => matchMedia('(dynamic-range: high)').matches;
  let hdr: boolean =
    !!video?.hdr && !navigator.mediaCapabilities && hdrScreen();
  if (video && vc && navigator.mediaCapabilities) {
    const config = {
      contentType: videoType,
      width: video.width ?? 1920,
      height: video.height ?? 1080,
      bitrate: video.bitrate || media.bitrate || 8000000,
      framerate: video.frameRate || 24,
    };
    try {
      const result = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: config,
      });
      videoSupport = videoSupport && result.supported;
    } catch {
      /* Some browsers reject detailed capability requests. */
    }
    if (video.hdr && videoSupport) {
      try {
        const result = await navigator.mediaCapabilities.decodingInfo({
          type: 'media-source',
          video: { ...config, colorGamut: 'rec2020', transferFunction: 'pq' },
        });
        hdr = result.supported;
      } catch {
        hdr = hdrScreen();
      }
    }
  }
  if (audio && ac && navigator.mediaCapabilities) {
    try {
      const result = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        audio: {
          contentType: audioType,
          channels: String(audio.channels ?? 2),
          bitrate: audio.bitrate || 192000,
          samplerate: audio.sampleRate || 48000,
        },
      });
      audioSupport = audioSupport && result.supported;
    } catch {
      /* Keep the basic result. */
    }
  }
  /** Whether the browser outputs to six channels or more. */
  const surroundOutput = () => {
    if (typeof AudioContext === 'undefined') return false;
    const context = new AudioContext();
    const channels = context.destination.maxChannelCount;
    void context.close().catch(() => {});
    return channels >= 6;
  };
  const plays = async (
    contentType: string,
    channels: number,
    bitrate: number
  ) => {
    try {
      const result = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        audio: {
          contentType,
          channels: String(channels),
          bitrate,
          samplerate: 48000,
        },
      });
      return result.supported;
    } catch {
      return false;
    }
  };
  // Whether converted surround can stay surround, and as what: FLAC at the
  // source's layout up to 7.1, else 5.1 AAC, asked directly.
  let surround = false,
    lossless = false;
  if ((audio?.channels ?? 2) > 2 && navigator.mediaCapabilities) {
    const [flac, aac] = await Promise.all([
      plays('audio/mp4; codecs="flac"', 8, 6912000),
      plays('audio/mp4; codecs="mp4a.40.2"', 6, 384000),
    ]);
    // On a stereo output the transcoder's own downmix (normalised, no
    // clipping) beats the browser's: surround is kept for speakers, and for
    // headphones where it's rendered here with an HRTF.
    surround = (flac || aac) && (headphones || surroundOutput());
    lossless = surround && flac;
  }
  const codecs = [vc, ac].filter(Boolean).join(',');
  // ASS and PGS are drawn here, not burned in, where the renderers run.
  const subtitles: ('ass' | 'pgs')[] = canRender() ? ['ass', 'pgs'] : [];
  return {
    video: videoSupport,
    audio: audioSupport,
    container:
      !!mime && !!vc && !!el.canPlayType(`${mime}; codecs="${codecs}"`),
    hdr,
    surround,
    lossless,
    // On headphones TrueHD and E-AC-3 are rendered to binaural (Dolby Atmos for Headphones'
    // renderer), by the server or, for the codecs below, here; other audio is virtualised here.
    binaural: headphones,
    // Where this browser can run the renderer itself, the transcoder sends TrueHD as it is.
    ...(headphones && clientBinauralSupported()
      ? { clientBinaural: [...CLIENT_BINAURAL_CODECS] }
      : {}),
    subtitles,
  };
}
