/*
 * The WebGPU shader drawing a Dolby Vision frame: math.ts's doviPixel (or hdr10Pixel without an
 * RPU) and toCanvas per pixel, from the decoded 10-bit planes (I420P10) of the base layer.
 * Parameters packed by math.ts's packParams.
 */
import { BT2020_TO_P3, COMP_FLOATS, HEAD_FLOATS } from './math';

const m = BT2020_TO_P3;
/** Column-major, as WGSL's mat3x3f constructor takes it. */
const P3_COLS = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].join(
  ', '
);

export const DOVI_SHADER = /* wgsl */ `
@group(0) @binding(0) var lumaTex: texture_2d<u32>;
@group(0) @binding(1) var cbTex: texture_2d<u32>;
@group(0) @binding(2) var crTex: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
@group(0) @binding(4) var<uniform> view: vec4f; // frame width, height, then canvas width, height
// 0: I420P10 (Cb and Cr planes, 10-bit values); 1: P010 (interleaved CbCr in cbTex, 16-bit values)
@group(0) @binding(5) var<uniform> layout: vec4u;

const HEAD = ${HEAD_FLOATS}u;
const COMP = ${COMP_FLOATS}u;
const PQ_M1 = ${2610 / 16384};
const PQ_M2 = ${(2523 / 4096) * 128};
const PQ_C1 = ${3424 / 4096};
const PQ_C2 = ${(2413 / 4096) * 32};
const PQ_C3 = ${(2392 / 4096) * 32};

fn pqEotf(v: vec3f) -> vec3f {
  let p = pow(clamp(v, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / PQ_M2));
  return pow(max(p - vec3f(PQ_C1), vec3f(0.0)) / (vec3f(PQ_C2) - vec3f(PQ_C3) * p), vec3f(1.0 / PQ_M1));
}

fn mat(at: u32) -> mat3x3f {
  // row-major in the buffer; WGSL matrices are column-major
  return transpose(mat3x3f(P[at], P[at + 1u], P[at + 2u], P[at + 3u], P[at + 4u], P[at + 5u],
                           P[at + 6u], P[at + 7u], P[at + 8u]));
}

fn srgbEncode(v: vec3f) -> vec3f {
  let a = abs(v);
  let e = select(1.055 * pow(a, vec3f(1.0 / 2.4)) - vec3f(0.055), 12.92 * a, a <= vec3f(0.0031308));
  return sign(v) * e;
}

// One plane's sample, bilinear (chroma: left-sited horizontally, centred vertically)
fn plane(t: texture_2d<u32>, pos: vec2f) -> f32 { return planeAt(t, pos, 0u); }
fn planeAt(t: texture_2d<u32>, pos: vec2f, ch: u32) -> f32 {
  let size = vec2i(textureDimensions(t));
  let p = clamp(pos, vec2f(0.0), vec2f(size - vec2i(1)));
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let j = min(i + vec2i(1), size - vec2i(1));
  let a = f32(textureLoad(t, i, 0)[ch]);
  let b = f32(textureLoad(t, vec2i(j.x, i.y), 0)[ch]);
  let c = f32(textureLoad(t, vec2i(i.x, j.y), 0)[ch]);
  let d = f32(textureLoad(t, j, 0)[ch]);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn reshape(sig0: vec3f) -> vec3f {
  var lo: vec3f;
  var hi: vec3f;
  for (var c = 0u; c < 3u; c++) {
    let base = HEAD + c * COMP;
    let n = u32(P[base]);
    lo[c] = P[base + 1u];
    hi[c] = P[base + n];
  }
  let sig = clamp(sig0, lo, hi);
  let sigX = vec4f(sig.x * sig.y, sig.x * sig.z, sig.y * sig.z, sig.x * sig.y * sig.z);
  var out: vec3f;
  for (var c = 0u; c < 3u; c++) {
    let base = HEAD + c * COMP;
    let n = u32(P[base]);
    let s = sig[c];
    var i = 0u;
    for (var j = 1u; j + 1u < n; j++) {
      if (s >= P[base + 1u + j]) { i = j; }
    }
    let k = base + 10u + i * 4u;
    var r: f32;
    if (P[k] == 0.0) {
      r = (P[k + 3u] * s + P[k + 2u]) * s + P[k + 1u];
    } else {
      let order = u32(P[k + 1u]);
      r = P[k + 2u];
      var e = vec3f(1.0);
      var eX = vec4f(1.0);
      for (var o = 0u; o < order; o++) {
        e = e * sig;
        eX = eX * sigX;
        let m = base + 10u + 32u + i * 21u + o * 7u;
        r += dot(vec3f(P[m], P[m + 1u], P[m + 2u]), e)
           + dot(vec4f(P[m + 3u], P[m + 4u], P[m + 5u], P[m + 6u]), eX);
      }
    }
    out[c] = clamp(r, 0.0, 1.0);
  }
  return out;
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  // canvas pixel to frame pixel
  let pos = (frag.xy) * view.xy / view.zw - vec2f(0.5);
  let cpos = vec2f(pos.x * 0.5, (pos.y + 0.5) * 0.5 - 0.5);
  var ycc: vec3f;
  if (layout.x == 1u) {
    // P010: the 10-bit value in the top bits
    ycc = vec3f(plane(lumaTex, pos), planeAt(cbTex, cpos, 0u), planeAt(cbTex, cpos, 1u)) / 64.0;
  } else {
    ycc = vec3f(plane(lumaTex, pos), plane(cbTex, cpos), plane(crTex, cpos));
  }
  var nits: vec3f;
  if (P[22] == 1.0) {
    let r = reshape(ycc / 1024.0);
    let pq = mat(0u) * (r - vec3f(P[9], P[10], P[11]));
    nits = clamp(mat(12u) * pqEotf(pq), vec3f(0.0), vec3f(1.0)) * 10000.0;
  } else {
    let Y = (ycc.x - 64.0) / 876.0;
    let U = (ycc.y - 512.0) / 896.0;
    let V = (ycc.z - 512.0) / 896.0;
    let rgb = vec3f(Y + 1.4746 * V, Y - 0.16455312684366 * U - 0.57135312684366 * V, Y + 1.8814 * U);
    nits = pqEotf(rgb) * 10000.0;
  }
  let p3 = mat3x3f(${P3_COLS}) * (nits / P[21]);
  return vec4f(srgbEncode(p3), 1.0);
}
`;
