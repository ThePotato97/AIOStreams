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
}
