/**
 * Guest playback contract; no upstream addresses or configuration credentials. A guest's browser
 * plays the host's file directly, so the server describes only what the page needs before the
 * player reads the file itself.
 */
/** The file the party plays, as far as the server knows it without reading it. */
export interface GuestFile {
  /** Its container, from the file's name ("mkv", "mp4", ...), which the player's own subtitle reading needs; null where unknown. */
  container: string | null;
  /** Its length, from the party's entry; null where unknown, as the player finds it in the file. */
  durationMs: number | null;
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
