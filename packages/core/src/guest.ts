import { z } from 'zod';

/** Guest playback contract; no upstream addresses or configuration credentials. */
export interface GuestTrack {
  index: number;
  type: 'video' | 'audio' | 'subtitle';
  codec: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
  channels?: number;
  sampleRate?: number;
  hdr?: boolean;
  /** Video: ffmpeg's pixel format ("yuv420p10le"). */
  pixelFormat?: string;
  /** Video: bits per sample. */
  bitDepth?: number;
  /** Video: transfer characteristics ("smpte2084" PQ, "arib-std-b67" HLG). */
  transfer?: string;
  /** Video: "progressive", or an interlaced field order ("tt", "bb", "tb", "bt"). */
  fieldOrder?: string;
  /** Video: the sample aspect ratio ("1:1"; anything else is anamorphic). */
  sampleAspectRatio?: string;
  /** Video: Dolby Vision's configuration, where it has one, and which layers it carries. */
  dovi?: {
    profile: number;
    compatibility: number;
    layers: { base: boolean; enhancement: boolean; rpu: boolean };
  };
  /** Video: HDR10+ dynamic metadata, seen on its first frame. */
  hdr10plus?: boolean;
  title: string;
  language?: string;
  /** ffprobe's channel layout name ("5.1(side)"). */
  layout?: string;
  default?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
  visualImpaired?: boolean;
}
export interface GuestMedia {
  durationMs: number;
  container: string;
  bitrate: number;
  tracks: GuestTrack[];
  /** Fonts attached to the file, which its ASS subtitles are styled with. */
  fonts?: { index: number; filename: string; mimetype: string }[];
  chapters: { title: string; startMs: number }[];
}
/**
 * The host's artwork for the title playing, as the host's item has it: Jellyfin image tags, which
 * carry each image's address, so the image route serves them without a session.
 */
export interface GuestArtwork {
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentLogoItemId?: string;
  ParentLogoImageTag?: string;
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  ParentThumbItemId?: string;
  ParentThumbImageTag?: string;
  Overview?: string;
}
/** An intro, recap or credits, as the host's segment providers have it. */
export interface GuestSegment {
  Type: 'Intro' | 'Recap' | 'Outro';
  StartTicks: number;
  EndTicks: number;
}
export interface GuestCapabilities {
  video: boolean;
  audio: boolean;
  container: boolean;
  hdr: boolean;
  /** Plays 5.1 AAC: converted surround stays surround. */
  surround?: boolean;
  /** Plays FLAC up to 7.1: converted surround is lossless, at its own layout. */
  lossless?: boolean;
  /**
   * Listening on headphones: TrueHD and E-AC-3 (Atmos or not) are rendered to binaural stereo
   * on the server, by Dolby Atmos for Headphones' renderer.
   */
  binaural?: boolean;
  /**
   * Audio codecs the player decodes itself (in WebAssembly), rendering binaural for headphones
   * and the speaker version otherwise: a track in one of these is copied as it is, with
   * headphones on or off, and the server doesn't render it.
   */
  clientBinaural?: ('truehd' | 'eac3' | 'ac3' | 'dts')[];
  /**
   * The listener's headphone mode where the server renders binaural: every element Near (as
   * Windows renders) or Far. Without it, each element in the stream's own mode (Mid where the
   * stream has none), as Dolby's Reference Player renders.
   */
  binauralMode?: 'near' | 'far';
  /** Subtitle formats the browser draws itself, rather than burned in. */
  subtitles?: ('ass' | 'pgs')[];
  /**
   * What the page's picture renderer draws over the video: `dovi` is Dolby Vision from each
   * frame's metadata (WebGPU on an HDR canvas), so Dolby Vision video is copied with its
   * metadata, profile 5 included, rather than converted.
   */
  picture?: ('dovi' | 'tonemap-sdr')[];
  /** The screen: HDR or SDR. A hint; whether this file's video shows as HDR is `hdr`. */
  display?: 'sdr' | 'hdr';
  /** Containers the page demuxes itself. A hint; nothing is demuxed in the page yet. */
  demux?: 'matroska'[];
}

/**
 * Where each stream's work happens and what it outputs, as the transcoder decides it. Every
 * value a planned feature needs is here; the transcoder chooses only the ones built so far
 * (services/transcoder/media.mjs `playbackSpec`, whose JSDoc mirrors this and whose output is
 * checked against it through fixtures/spec-examples.json).
 */
export const guestPlaybackSpecSchema = z
  .object({
    video: z
      .object({
        track: z.number().int(),
        /** The original file in the page; demuxed by the page; copied or encoded on the server. */
        where: z.enum([
          'page-original',
          'page-demux',
          'server-copy',
          'server-encode',
        ]),
        encode: z
          .object({
            codec: z.enum(['h264', 'hevc10', 'av1']),
            range: z.enum(['sdr', 'hdr10']),
            tonemap: z.enum(['none', 'server']),
            deinterlace: z.boolean(),
            /** The output height; null keeps the source's. */
            scale: z.number().int().nullable(),
            maxBitrate: z.string().nullable(),
          })
          .strict()
          .nullable(),
        /** What the page draws over the video. */
        picture: z.enum(['none', 'dovi', 'tonemap-sdr']),
        reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
    audio: z
      .object({
        track: z.number().int(),
        where: z.enum([
          'page-original',
          'server-copy',
          'server-convert',
          'server-render',
        ]),
        /** Copied for the page to render itself (binaural, or the speaker version). */
        pageRenders: z.boolean(),
        convert: z
          .object({
            codec: z.enum(['flac', 'aac']),
            layout: z.enum(['stereo', '5.1', '7.1']),
            channels: z.number().int(),
            bitrate: z.string().nullable(),
          })
          .strict()
          .nullable(),
        /** Rendered to binaural on the server, in this headphone mode (null: as mixed). */
        render: z
          .object({
            binaural: z.literal(true),
            mode: z.enum(['near', 'far']).nullable(),
            codec: z.enum(['flac', 'aac']),
            bitrate: z.string().nullable(),
          })
          .strict()
          .nullable(),
        reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
    subtitle: z
      .object({
        track: z.number().int(),
        /** Drawn by the page, or burned in on the server. */
        where: z.enum(['page', 'server-burn']),
        format: z.enum(['text', 'ass', 'pgs', 'vobsub', 'dvb']).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type GuestPlaybackSpec = z.infer<typeof guestPlaybackSpecSchema>;
export interface GuestPlaybackRequest {
  revision: string;
  capabilities: GuestCapabilities;
  quality: 'original' | '1080p' | '720p';
  audio?: number;
  subtitle?: number;
  positionMs: number;
  force?: boolean;
}
export interface GuestPlayback {
  lease: string;
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  media: GuestMedia;
  mode: 'direct' | 'remux' | 'audio' | 'video';
  url: string;
  offsetMs: number;
  subtitleUrl?: string;
  /** How the subtitle is served: WebVTT, ASS for JASSUB, PGS for libpgs. */
  subtitleFormat?: 'vtt' | 'ass' | 'sup';
  /** Where each stream's work was asked to happen. */
  spec: GuestPlaybackSpec;
  /**
   * Where it happens: the spec after any fallback (no binaural, the CPU). What the page
   * renders, draws or plays as it is follows this one.
   */
  effective: GuestPlaybackSpec;
  /** Fonts attached to the file, for an ASS subtitle. */
  fontUrls?: string[];
  /**
   * A converted playback's state when it was admitted: it plays once `ready`; until then the
   * page follows it (`/prepare/:lease/state`). A direct one is ready at once.
   */
  version?: number;
  stage?: GuestPlaybackStage;
  ready?: boolean;
  failure?: GuestPlaybackFailure | null;
}
/** Where a converted playback is, as the transcoder sets it where each event happens. */
export type GuestPlaybackStage =
  | 'opening'
  | 'waitingAudio'
  | 'rendering'
  | 'waitingSource'
  | 'encoding'
  | 'ready'
  | 'paused'
  | 'finished'
  | 'failed';
/**
 * Why a converted playback won't play. `source`: the file failed (`code` says whether another try
 * may help); `capacity`: the server is full; `encoder`, `conversion`: the conversion failed.
 */
export interface GuestPlaybackFailure {
  class: 'source' | 'capacity' | 'encoder' | 'conversion';
  status?: number;
  code?: string;
  reason?: string;
}
/** A converted playback's state, as the long poll answers it. */
export interface GuestPlaybackState {
  version: number;
  stage: GuestPlaybackStage;
  ready: boolean;
  mode: GuestPlayback['mode'];
  effective: GuestPlaybackSpec;
  /** Where it plays from, in the source's time, once ready. */
  startMs: number | null;
  failure: GuestPlaybackFailure | null;
}
