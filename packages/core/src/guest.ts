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
  title: string;
  language?: string;
  default?: boolean;
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
   * Audio codecs the player renders to binaural itself (in WebAssembly): with `binaural`, a
   * track in one of these is copied as it is, and the server doesn't render it.
   */
  clientBinaural?: ('truehd' | 'eac3')[];
  /**
   * The player draws Dolby Vision itself from each frame's metadata (WebGPU on an HDR canvas):
   * Dolby Vision video is copied with its metadata, profile 5 included, rather than converted.
   */
  dovi?: boolean;
  /** Subtitle formats the browser draws itself, rather than burned in. */
  subtitles?: ('ass' | 'pgs')[];
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
  /** The audio was rendered to binaural on the server: the player adds no virtualiser. */
  binaural?: boolean;
  /** The audio is copied for the player to render to binaural itself. */
  clientBinaural?: boolean;
  /** The video is Dolby Vision copied with its metadata for the player to draw. */
  dovi?: boolean;
  /** Fonts attached to the file, for an ASS subtitle. */
  fontUrls?: string[];
}
