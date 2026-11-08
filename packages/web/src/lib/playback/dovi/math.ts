/*
 * The Dolby Vision picture from the base layer and its RPU, as libplacebo computes it
 * (src/shaders/colorspace.c: pl_shader_dovi_reshape, then pl_shader_decode_color for
 * PL_COLOR_SYSTEM_DOLBYVISION): each component reshaped (polynomial or MMR), the RPU's YCbCr
 * matrix, PQ to linear, the RPU's LMS matrix with Dolby's fixed LMS to BT.2020, giving linear
 * BT.2020 light. Then, for the page: Display P3 relative to SDR white, sRGB-encoded with an
 * extended range, which an HDR canvas (rgba16float, toneMapping "extended") shows as is.
 *
 * Here as the reference the WebGPU shader (shader.ts) is checked against, and as the packing
 * of its parameters.
 */
import type { DoviParams } from './rpu';

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** PQ to linear light, 0..1 of 10000 nits (libplacebo's PQ EOTF, input clamped to 0..1). */
export function pqEotf(v: number): number {
  const p = Math.pow(Math.min(Math.max(v, 0), 1), 1 / PQ_M2);
  return Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}

/** Dolby's fixed LMS to BT.2020 RGB (libplacebo's dovi_lms2rgb). */
const LMS2RGB = [
  3.06441879, -2.16597676, 0.10155818, -0.65612108, 1.78554118, -0.12943749,
  0.01736321, -0.04725154, 1.03004253,
];

export const mul3 = (a: number[], b: number[]) => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out.push(
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
      );
  return out;
};
const apply3 = (m: number[], v: number[]) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** RGB to XYZ for primaries (x, y pairs: red, green, blue) and a white point. */
function rgbToXyz(p: number[][], w: number[]): number[] {
  const col = (x: number, y: number) => [x / y, 1, (1 - x - y) / y];
  const [r, g, b] = p.map(([x, y]) => col(x, y));
  const m = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = apply3(invert3(m), col(w[0], w[1]));
  return [
    m[0] * s[0],
    m[1] * s[1],
    m[2] * s[2],
    m[3] * s[0],
    m[4] * s[1],
    m[5] * s[2],
    m[6] * s[0],
    m[7] * s[1],
    m[8] * s[2],
  ];
}
function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}
const D65 = [0.3127, 0.329];
const BT2020 = [
  [0.708, 0.292],
  [0.17, 0.797],
  [0.131, 0.046],
];
const P3 = [
  [0.68, 0.32],
  [0.265, 0.69],
  [0.15, 0.06],
];
/** Linear BT.2020 to linear Display P3. */
export const BT2020_TO_P3 = mul3(
  invert3(rgbToXyz(P3, D65)),
  rgbToXyz(BT2020, D65)
);

/** SDR reference white, nits (BT.2408): 1.0 on the page's extended-range canvas. */
export const SDR_WHITE_NITS = 203;

/** Each component reshaped (pl_shader_dovi_reshape), signal 0..1 (code / 2^bit depth). */
export function reshape(sig0: number[], p: DoviParams): number[] {
  const sig = sig0.map((v, c) => {
    const piv = p.comp[c].pivots;
    return Math.min(Math.max(v, piv[0]), piv[piv.length - 1]);
  });
  const x = sig[0],
    y = sig[1],
    z = sig[2];
  const sigX = [x * y, x * z, y * z, x * y * z];
  return p.comp.map((k, c) => {
    const s = sig[c];
    let i = 0;
    for (let j = 1; j < k.pivots.length - 1; j++) if (s >= k.pivots[j]) i = j;
    let out: number;
    if (k.method[i] === 0) {
      const [c0, c1, c2] = k.poly[i];
      out = (c2 * s + c1) * s + c0;
    } else {
      const m = k.mmr[i];
      out = k.mmrConstant[i];
      for (let o = 0; o < k.mmrOrder[i]; o++) {
        const e = o + 1;
        out +=
          m[o][0] * x ** e +
          m[o][1] * y ** e +
          m[o][2] * z ** e +
          m[o][3] * sigX[0] ** e +
          m[o][4] * sigX[1] ** e +
          m[o][5] * sigX[2] ** e +
          m[o][6] * sigX[3] ** e;
      }
    }
    return Math.min(Math.max(out, 0), 1);
  });
}

/** The RPU's matrices combined as the shader uses them: LMS to BT.2020 after the RPU's RGB to LMS. */
export const lmsToRgb = (p: DoviParams) => mul3(LMS2RGB, p.linear);

/** Linear BT.2020 light, nits, of one pixel of the base layer (Y, Cb, Cr codes / 2^bit depth). */
export function doviPixel(ycc: number[], p: DoviParams): number[] {
  const r = reshape(ycc, p);
  const pq = apply3(
    p.nonlinear,
    r.map((v, i) => v - p.nonlinearOffset[i])
  );
  const lin = apply3(lmsToRgb(p), pq.map(pqEotf));
  // libplacebo's PQ OETF then the output's PQ EOTF: clamped to 0..1 (10000 nits)
  return lin.map((v) => Math.min(Math.max(v, 0), 1) * 10000);
}

/** A plain HDR10 pixel (BT.2020 limited range, PQ): 10-bit codes. */
export function hdr10Pixel(y: number, cb: number, cr: number): number[] {
  const Y = (y - 64) / 876,
    U = (cb - 512) / 896,
    V = (cr - 512) / 896;
  // BT.2020 non-constant luminance
  const rgb = [
    Y + 1.4746 * V,
    Y - 0.16455312684366 * U - 0.57135312684366 * V,
    Y + 1.8814 * U,
  ];
  return rgb.map((v) => pqEotf(v) * 10000);
}

/** sRGB's transfer, extended to values outside 0..1 by symmetry (the extended canvas). */
export function srgbEncode(v: number): number {
  const a = Math.abs(v);
  const e = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return Math.sign(v) * e;
}

/** Linear BT.2020 nits to what the extended Display P3 canvas takes. */
export function toCanvas(nits: number[]): number[] {
  return apply3(
    BT2020_TO_P3,
    nits.map((v) => v / SDR_WHITE_NITS)
  ).map(srgbEncode);
}

/** Per reshaping component in the packed parameters. */
export const COMP_FLOATS = 1 + 9 + 8 * 4 + 8 * 21;
/** Before the components. */
export const HEAD_FLOATS = 24;
export const PARAM_FLOATS = HEAD_FLOATS + 3 * COMP_FLOATS;

/**
 * The parameters as the shader reads them:
 * [0..9) YCbCr matrix, [9..12) its offsets, [12..21) LMS to BT.2020 (lmsToRgb), [21] SDR white
 * nits, [22] 1 with an RPU (else plain HDR10), then per component: pivot count, 9 pivots, per
 * piece (method, c0, c1, c2) or (method, MMR order, constant, 0), then per piece 3 x 7 MMR
 * coefficients.
 */
export function packParams(
  p: DoviParams | null,
  out = new Float32Array(PARAM_FLOATS)
) {
  out.fill(0);
  out[21] = SDR_WHITE_NITS;
  if (!p) return out;
  out.set(p.nonlinear, 0);
  out.set(p.nonlinearOffset, 9);
  out.set(lmsToRgb(p), 12);
  out[22] = 1;
  p.comp.forEach((k, c) => {
    const base = HEAD_FLOATS + c * COMP_FLOATS;
    out[base] = k.pivots.length;
    out.set(k.pivots, base + 1);
    for (let i = 0; i < k.method.length; i++) {
      const at = base + 10 + i * 4;
      if (k.method[i] === 0) out.set([0, ...k.poly[i]], at);
      else {
        out.set([1, k.mmrOrder[i], k.mmrConstant[i], 0], at);
        k.mmr[i].forEach((row, o) =>
          out.set(row, base + 10 + 32 + i * 21 + o * 7)
        );
      }
    }
  });
  return out;
}
