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
  /** Video: Dolby Vision's configuration, where it has one. */
  dovi?: { profile: number; compatibility: number };
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
  /**
   * The player draws Dolby Vision itself from each frame's metadata (WebGPU on an HDR canvas):
   * Dolby Vision video is copied with its metadata, profile 5 included, rather than converted.
   */
  dovi?: boolean;
  /** Subtitle formats the browser draws itself, rather than burned in. */
  subtitles?: ('ass' | 'pgs')[];
  /**
   * What the page's picture renderer draws over the video: `dovi` is Dolby Vision from each
   * frame's metadata (replacing the `dovi` flag). Later: SDR tone-mapping of HDR.
   */
  picture?: 'dovi'[];
  /** The screen: HDR or SDR. A hint; whether this file's video shows as HDR is `hdr`. */
  display?: 'sdr' | 'hdr';
}

/**
 * Where each stream's work happens and what it outputs, as the transcoder decided it (and, once
 * a conversion runs, after any fallback). Values marked "later" are where planned features go.
 */
export interface GuestPlaybackSpec {
  video: {
    track: number;
    /** The original file in the page; copied or encoded on the server. Later: 'page-demux'. */
    where: 'page-original' | 'server-copy' | 'server-encode';
    encode: {
      /** Later: 'hevc10', 'av1'. */
      codec: 'h264';
      /** Later: 'hdr10'. */
      range: 'sdr';
      tonemap: 'none' | 'server';
      /** Later: true for interlaced sources. */
      deinterlace: false;
      height: number | null;
      maxBitrate: string | null;
    } | null;
    /** What the page draws over the video. Later: 'tonemap-sdr'. */
    picture: 'none' | 'dovi';
    reason: string | null;
  } | null;
  audio: {
    track: number;
    where: 'page-original' | 'server-copy' | 'server-convert' | 'server-render';
    /** Copied for the page to render itself (binaural, or the speaker version). */
    pageRenders: boolean;
    /** Rendered to binaural on the server, in this headphone mode (null: as mixed). */
    render: { mode: 'near' | 'far' | null } | null;
    output: {
      codec: 'flac' | 'aac';
      bitrate: string | null;
      layout: string | null;
      channels: number | null;
    } | null;
    reason: string | null;
  } | null;
  subtitle: {
    track: number;
    /** Later: the page drawing VobSub and DVB too. */
    where: 'page' | 'server-burn';
    kind: 'text' | 'ass' | 'pgs' | 'vobsub' | 'dvb' | null;
  } | null;
}
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
  /** Where each stream's work happens: what the page renders, draws or plays as it is. */
  spec: GuestPlaybackSpec;
  /** Fonts attached to the file, for an ASS subtitle. */
  fontUrls?: string[];
}
