/*
 * FLAC for the audio rendered in the browser: 24-bit frames (fixed prediction and Rice coding,
 * FLAC's simplest compression, which every browser that plays FLAC through MSE decodes).
 */

export const FLAC_RATE = 48000;
export const FLAC_BITS = 24;
/** Samples per frame; a tail under FLAC_MIN_BLOCK goes into the frame before it. */
export const FLAC_BLOCK = 4096;
export const FLAC_MIN_BLOCK = 16;
export const FLAC_MAX_BLOCK = FLAC_BLOCK + FLAC_MIN_BLOCK - 1;

/** CRC tables, a byte at a time: CRC-8 (polynomial 0x07, frame headers), CRC-16 (0x8005, frames). */
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}

function crc8(bytes: Uint8Array, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i++) crc = CRC8[crc ^ bytes[i]];
  return crc;
}

function crc16(bytes: Uint8Array, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i++)
    crc = ((crc << 8) & 0xffff) ^ CRC16[(crc >> 8) ^ bytes[i]];
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
export function streamInfo(channels = 2): Uint8Array {
  const b = new Uint8Array(34);
  const v = new DataView(b.buffer);
  v.setUint16(0, FLAC_MIN_BLOCK);
  v.setUint16(2, FLAC_MAX_BLOCK);
  // min/max frame size unknown (0); then 20 bits rate, 3 bits channels - 1, 5 bits bps - 1,
  // 36 bits total samples (0, unknown), MD5 (0)
  const word =
    (FLAC_RATE << 12) | ((channels - 1) << 9) | ((FLAC_BITS - 1) << 4);
  v.setUint32(10, word >>> 0);
  return b;
}

/** Writes bits most significant first. */
class Bits {
  private buf: Uint8Array;
  private at = 0;
  /** Bits not yet written, fewer than 8, in the low bits. */
  private acc = 0;
  private count = 0;
  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }
  /** The low `n` bits (up to 24) of `value`. */
  put(value: number, n: number) {
    if (n === 0) return;
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.count += n;
    if (this.at + 4 > this.buf.length) this.grow();
    while (this.count >= 8) {
      this.count -= 8;
      this.buf[this.at++] = (this.acc >>> this.count) & 0xff;
    }
    this.acc &= (1 << this.count) - 1;
  }
  /** The low `n` bits (up to 31) of `value`. */
  putLong(value: number, n: number) {
    if (n > 24) {
      this.put(Math.floor(value / 2 ** 24), n - 24);
      this.put(value % 2 ** 24, 24);
    } else this.put(value, n);
  }
  /** `q` zeros, then a one. */
  unary(q: number) {
    while (q >= 24) {
      this.put(0, 24);
      q -= 24;
    }
    this.put(1, q + 1);
  }
  /** A signed value in `n` bits, two's complement. */
  signed(value: number, n: number) {
    this.put(value < 0 ? value + 2 ** n : value, n);
  }
  private grow() {
    const next = new Uint8Array(this.buf.length * 2 + 8);
    next.set(this.buf);
    this.buf = next;
  }
  /** The bytes written, the last one padded with zeros. */
  bytes(): Uint8Array {
    if (this.count) this.put(0, 8 - this.count);
    return this.buf.subarray(0, this.at);
  }
}

/** Rice parameters are 5 bits (RICE2); 31 is the escape code. */
const MAX_RICE = 30;
/** The most partition orders searched, as libFLAC's highest preset (-8). */
const MAX_PARTITION_ORDER = 6;
const POW2 = Array.from({ length: MAX_RICE + 2 }, (_, i) => 2 ** i);

/**
 * The Rice parameter for a partition of `count` values summing to `sum`, and its cost in bits
 * estimated as libFLAC does (each value's quotient taken as the sum's).
 */
function rice(sum: number, count: number) {
  const mean = sum / Math.max(1, count);
  let k = mean > 1 ? Math.min(MAX_RICE, Math.floor(Math.log2(mean))) : 0;
  let bits = count * (k + 1) + Math.floor(sum / POW2[k]);
  // the estimate's own best is next to the mean's
  if (k > 0) {
    const below = count * k + Math.floor(sum / POW2[k - 1]);
    if (below < bits) return { k: k - 1, bits: below };
  }
  if (k < MAX_RICE) {
    const above = count * (k + 2) + Math.floor(sum / POW2[k + 1]);
    if (above < bits) {
      bits = above;
      k++;
    }
  }
  return { k, bits };
}

/** A channel's subframe: constant, fixed prediction with Rice-coded residuals, or verbatim. */
function subframe(out: Bits, x: Int32Array, u: Uint32Array) {
  const n = x.length;
  let constant = true;
  for (let i = 1; i < n && constant; i++) constant = x[i] === x[0];
  if (constant) {
    out.put(0x00, 8); // constant
    out.signed(x[0], FLAC_BITS);
    return;
  }
  // the fixed order with the smallest residual, in one pass of running differences
  let order = 0;
  if (n > 4) {
    let l0 = x[3],
      l1 = x[3] - x[2],
      l2 = x[3] - 2 * x[2] + x[1],
      l3 = x[3] - 3 * x[2] + 3 * x[1] - x[0];
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0,
      s4 = 0;
    for (let i = 4; i < n; i++) {
      const e0 = x[i];
      const e1 = e0 - l0;
      const e2 = e1 - l1;
      const e3 = e2 - l2;
      const e4 = e3 - l3;
      s0 += Math.abs(e0);
      s1 += Math.abs(e1);
      s2 += Math.abs(e2);
      s3 += Math.abs(e3);
      s4 += Math.abs(e4);
      l0 = e0;
      l1 = e1;
      l2 = e2;
      l3 = e3;
    }
    const sums = [s0, s1, s2, s3, s4];
    for (let o = 1; o < 5; o++) if (sums[o] < sums[order]) order = o;
  }
  // its residuals, zigzagged
  for (let i = order; i < n; i++) {
    let r: number;
    switch (order) {
      case 0:
        r = x[i];
        break;
      case 1:
        r = x[i] - x[i - 1];
        break;
      case 2:
        r = x[i] - 2 * x[i - 1] + x[i - 2];
        break;
      case 3:
        r = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
        break;
      default:
        r = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    u[i] = r >= 0 ? 2 * r : -2 * r - 1;
  }
  // partitions divide the block evenly, and the first holds more than the warm-up
  let maxP = 0;
  while (
    maxP < MAX_PARTITION_ORDER &&
    n % (2 << maxP) === 0 &&
    n / (2 << maxP) > order
  )
    maxP++;
  // sums at the finest partitioning, merged pairwise for the coarser ones
  let sums: number[] = [];
  const finest = 1 << maxP;
  const size = n / finest;
  for (let j = 0; j < finest; j++) {
    let sum = 0;
    for (let i = j === 0 ? order : j * size; i < (j + 1) * size; i++)
      sum += u[i];
    sums.push(sum);
  }
  let plan: { p: number; ks: number[]; bits: number } | null = null;
  for (let p = maxP; p >= 0; p--) {
    const parts = 1 << p;
    const partSize = n / parts;
    const ks: number[] = [];
    let bits = 0;
    for (let j = 0; j < parts; j++) {
      const r = rice(sums[j], j === 0 ? partSize - order : partSize);
      ks.push(r.k);
      bits += 5 + r.bits;
    }
    if (!plan || bits < plan.bits) plan = { p, ks, bits };
    if (p > 0) {
      const merged: number[] = [];
      for (let j = 0; j < sums.length; j += 2)
        merged.push(sums[j] + sums[j + 1]);
      sums = merged;
    }
  }
  if (!plan || order * FLAC_BITS + plan.bits + 6 >= n * FLAC_BITS) {
    out.put(0x02, 8); // verbatim
    for (let i = 0; i < n; i++) out.signed(x[i], FLAC_BITS);
    return;
  }
  out.put(0x10 | (order << 1), 8); // fixed, this order, no wasted bits
  for (let i = 0; i < order; i++) out.signed(x[i], FLAC_BITS);
  out.put(1, 2); // partitioned Rice, 5-bit parameters
  out.put(plan.p, 4);
  const partSize = n >> plan.p;
  plan.ks.forEach((k, j) => {
    out.put(k, 5);
    const low = 2 ** k - 1;
    for (let i = j === 0 ? order : j * partSize; i < (j + 1) * partSize; i++) {
      const v = u[i];
      // u < 2^31, k <= 30: integer shifts
      const q = v >>> k;
      const r = v & low;
      // the quotient's zeros, its one and the remainder as one write where they fit
      if (q + 1 + k <= 24) out.put((1 << k) | r, q + 1 + k);
      else {
        out.unary(q);
        out.putLong(r, k);
      }
    }
  });
}

/**
 * One frame of interleaved float samples, `channels` of them (1 to 8), at most FLAC_MAX_BLOCK
 * frames, starting at stream sample `start`, as FLAC: variable block size, 24-bit, each channel
 * constant, fixed-predicted with Rice-coded residuals, or verbatim, whichever is smallest (the
 * buffer browsers keep for audio holds about 12 MB, so size decides how far ahead it reaches).
 */
export function flacFrame(
  samples: Float32Array,
  start: number,
  channels = 2
): Uint8Array {
  const n = samples.length / channels;
  const header = [
    0xff,
    0xf9, // sync, variable block size
    0x7a, // block size: 16-bit value at the end of the header; 48 kHz
    ((channels - 1) << 4) | 0x0c, // independent channels; 24 bits
    ...codedNumber(start),
    (n - 1) >> 8,
    (n - 1) & 0xff,
  ];
  const bits = new Bits(header.length + 1 + channels * (1 + 3 * n) + 2);
  for (const b of header) bits.put(b, 8);
  bits.put(crc8(new Uint8Array(header), header.length), 8);
  const scale = 2 ** (FLAC_BITS - 1) - 1;
  const x = new Int32Array(n);
  const u = new Uint32Array(n);
  for (let ch = 0; ch < channels; ch++) {
    for (let i = 0; i < n; i++)
      x[i] = Math.round(
        Math.max(-1, Math.min(1, samples[channels * i + ch])) * scale
      );
    subframe(bits, x, u);
  }
  const body = bits.bytes();
  const out = new Uint8Array(body.length + 2);
  out.set(body);
  const crc = crc16(out, body.length);
  out[body.length] = crc >> 8;
  out[body.length + 1] = crc & 0xff;
  return out;
}
