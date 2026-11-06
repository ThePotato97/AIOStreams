/* eslint-disable lingui/no-unlocalized-strings -- MIME strings are browser API inputs, not UI text. */
import type {
  GuestCapabilities,
  GuestMedia,
  GuestTrack,
} from '@aiostreams/core';
function codec(track: GuestTrack): string | null {
  switch (track.codec) {
    case 'h264': {
      const profile = track.profile?.toLowerCase() ?? '';
      const prefix = profile.includes('high')
        ? '6400'
        : profile.includes('main')
          ? '4d40'
          : '42e0';
      return `avc1.${prefix}${(track.level ?? 40).toString(16).padStart(2, '0')}`;
    }
    case 'hevc':
      return 'hvc1.1.6.L153.B0';
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
  audioIndex?: number
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
  const hdr = !!video?.hdr && matchMedia('(dynamic-range: high)').matches;
  if (video && vc && navigator.mediaCapabilities) {
    try {
      const result = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: {
          contentType: videoType,
          width: video.width ?? 1920,
          height: video.height ?? 1080,
          bitrate: video.bitrate || media.bitrate || 8000000,
          framerate: video.frameRate || 24,
          ...(hdr
            ? {
                colorGamut: 'rec2020' as const,
                transferFunction: 'pq' as const,
              }
            : {}),
        },
      });
      videoSupport = videoSupport && result.supported;
    } catch {
      /* Some browsers reject detailed capability requests. */
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
  const codecs = [vc, ac].filter(Boolean).join(',');
  return {
    video: videoSupport,
    audio: audioSupport,
    container:
      !!mime && !!vc && !!el.canPlayType(`${mime}; codecs="${codecs}"`),
    hdr,
  };
}
