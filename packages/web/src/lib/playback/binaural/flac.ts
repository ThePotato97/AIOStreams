/*
 * FLAC for the binaural audio rendered in the browser: verbatim (uncompressed) 24-bit stereo
 * frames, which every browser that plays FLAC through MSE decodes. Nothing leaves the device, so
 * compression isn't worth its cost.
 */

export const FLAC_RATE = 48000;
export const FLAC_BITS = 24;
/** Samples per frame; a tail under FLAC_MIN_BLOCK goes into the frame before it. */
export const FLAC_BLOCK = 4096;
export const FLAC_MIN_BLOCK = 16;
export const FLAC_MAX_BLOCK = FLAC_BLOCK + FLAC_MIN_BLOCK - 1;

/** CRC-8, polynomial 0x07 (frame headers). */
function crc8(bytes: Uint8Array, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++)
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** CRC-16, polynomial 0x8005 (whole frames). */
function crc16(bytes: Uint8Array, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** FLAC's UTF-8-style coding of a sample number (up to 36 bits). */
function codedNumber(n: number): number[] {
  if (n < 0x80) return [n];
  // bytes needed: 2 for 11 bits, 3 for 16, 4 for 21, 5 for 26, 6 for 31, 7 for 36
  const limits = [0, 0, 11, 16, 21, 26, 31, 36];
  let count = 2;
  while (n >= 2 ** limits[count]) count++;
  const out: number[] = [];
  let rest = n;
  for (let i = 0; i < count - 1; i++) {
    out.unshift(0x80 | (rest & 0x3f));
    rest = Math.floor(rest / 64);
  }
  const lead = (0xff << (8 - count)) & 0xff;
  out.unshift(lead | rest);
  return out;
}

/** The STREAMINFO metadata block's 34 bytes. */
export function streamInfo(): Uint8Array {
  const b = new Uint8Array(34);
  const v = new DataView(b.buffer);
  v.setUint16(0, FLAC_MIN_BLOCK);
  v.setUint16(2, FLAC_MAX_BLOCK);
  // min/max frame size unknown (0); then 20 bits rate, 3 bits channels - 1, 5 bits bps - 1,
  // 36 bits total samples (0, unknown), MD5 (0)
  const word = (FLAC_RATE << 12) | (1 << 9) | ((FLAC_BITS - 1) << 4);
  v.setUint32(10, word >>> 0);
  return b;
}

/**
 * One frame of interleaved stereo float samples (at most FLAC_MAX_BLOCK frames) starting at stream
 * sample `start`, as FLAC: variable block size, verbatim subframes, 24-bit.
 */
export function flacFrame(samples: Float32Array, start: number): Uint8Array {
  const n = samples.length / 2;
  const header = [
    0xff,
    0xf9, // sync, variable block size
    0x7a, // block size: 16-bit value at the end of the header; 48 kHz
    0x1c, // two independent channels; 24 bits
    ...codedNumber(start),
    (n - 1) >> 8,
    (n - 1) & 0xff,
  ];
  const size = header.length + 1 + 2 * (1 + 3 * n) + 2;
  const out = new Uint8Array(size);
  out.set(header);
  out[header.length] = crc8(out, header.length);
  let at = header.length + 1;
  const scale = 2 ** (FLAC_BITS - 1) - 1;
  for (let ch = 0; ch < 2; ch++) {
    out[at++] = 0x02; // verbatim subframe, no wasted bits
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, samples[2 * i + ch]));
      const s = Math.round(x * scale);
      out[at++] = (s >> 16) & 0xff;
      out[at++] = (s >> 8) & 0xff;
      out[at++] = s & 0xff;
    }
  }
  const crc = crc16(out, at);
  out[at++] = crc >> 8;
  out[at++] = crc & 0xff;
  return out;
}
