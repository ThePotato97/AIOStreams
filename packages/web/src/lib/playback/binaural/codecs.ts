/**
 * The codecs decoded and rendered in the page: TrueHD (by the renderer itself), E-AC-3 and AC-3
 * (FFmpeg's decoder as libav.js, the renderer reading their Atmos metadata), DTS (FFmpeg's
 * decoder; channels only). The server's names for them (ffprobe's).
 */
export type Codec = 'truehd' | 'eac3' | 'ac3' | 'dts';
