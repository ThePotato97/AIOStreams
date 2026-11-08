/*
 * Dolby Vision RPUs (the per-frame metadata in HEVC NAL units of type 62), parsed as FFmpeg's
 * libavcodec/dovi_rpudec.c parses them and mapped as libplacebo's pl_map_dovi_metadata maps
 * FFmpeg's result: the reshaping curves and colour matrices the renderer applies to the base
 * layer. The enhancement layer (profile 7) is not used, as libplacebo without one doesn't.
 */

/** libplacebo's pl_dovi_metadata, for one frame. */
export interface DoviParams {
  /** YCbCr to (PQ) RGB of the reshaped signal: offsets, then a row-major 3x3 matrix. */
  nonlinearOffset: [number, number, number];
  nonlinear: number[];
  /** RGB to LMS, row-major 3x3. */
  linear: number[];
  comp: ReshapeComponent[];
  /** The mastering display's range, PQ 0..1. */
  minPq: number;
  maxPq: number;
}

export interface ReshapeComponent {
  /** Normalized 0..1, ascending; one more than pieces. */
  pivots: number[];
  /** Per piece: 0 polynomial, 1 MMR. */
  method: number[];
  poly: [number, number, number][];
  mmrOrder: number[];
  mmrConstant: number[];
  /** [piece][order][7] */
  mmr: number[][][];
}

class Bits {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get left() {
    return this.b.length * 8 - this.pos;
  }
  get count() {
    return this.pos;
  }
  bit(): number {
    if (this.pos >= this.b.length * 8) throw new Error('RPU ended early');
    const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  sbits(n: number): number {
    const v = this.bits(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw new Error('Bad exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

interface Header {
  coefFloat: boolean;
  coefLog2Denom: number;
  blBitDepth: number;
  elBitDepth: number;
  disableResidual: boolean;
}

/** A coefficient's value (FFmpeg's get_se_coef / get_ue_coef, before libplacebo's 2^-denom). */
function coef(b: Bits, h: Header, signed: boolean): number {
  if (h.coefFloat) {
    const u = b.bits(32);
    const f = new DataView(new ArrayBuffer(4));
    f.setUint32(0, u);
    return f.getFloat32(0);
  }
  const ipart = signed ? b.se() : b.ue();
  return ipart + b.bits(h.coefLog2Denom) / 2 ** h.coefLog2Denom;
}

interface Mapping {
  comp: ReshapeComponent[];
}

interface Color {
  nonlinearOffset: [number, number, number];
  nonlinear: number[];
  linear: number[];
  minPq: number;
  maxPq: number;
}

/** FFmpeg's ff_dovi_color_default, for RPUs without display management metadata. */
const DEFAULT_COLOR: Color = {
  nonlinear: [9575, 0, 14742, 9575, -1754, -4383, 9575, 17372, 0].map(
    (v) => v / 8192
  ),
  nonlinearOffset: [1 / 16, 1 / 2, 1 / 2],
  linear: [5845, 9702, 837, 2568, 12256, 1561, 0, 679, 15705].map(
    (v) => v / 16384
  ),
  minPq: 62 / 4095,
  maxPq: 3696 / 4095,
};

/** The RPU's bytes from a NAL unit of type 62 (its two header bytes and emulation prevention gone). */
export function rpuFromNal(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 2; i < nal.length; i++) {
    const v = nal[i];
    if (zeros >= 2 && v === 3) {
      zeros = 0;
      continue;
    }
    zeros = v === 0 ? zeros + 1 : 0;
    out[n++] = v;
  }
  return out.subarray(0, n);
}

/** Parses RPUs in decoding order, keeping what later ones may refer back to. */
export class RpuParser {
  private vdr: (Mapping | null)[] = new Array(16).fill(null);
  private dm: Color | null = null;

  /** One RPU (from rpuFromNal); null for one that isn't a type-2 RPU. */
  parse(rpu: Uint8Array): DoviParams | null {
    if (rpu.length < 5 || rpu[0] !== 25) throw new Error('Not an RPU');
    let size = rpu.length;
    while (size > 1 && rpu[size - 1] === 0) size--;
    const b = new Bits(rpu.subarray(1, size));
    if (b.bits(6) !== 2) return null;
    const rpuFormat = b.bits(11);
    b.bits(4); // vdr_rpu_profile
    b.bits(4); // vdr_rpu_level
    if (!b.bit()) throw new Error('RPU without sequence info');
    b.bit(); // chroma_resampling_explicit_filter_flag
    const coefType = b.bits(2);
    if (coefType > 1) throw new Error('Unknown RPU coefficient type');
    const h: Header = {
      coefFloat: coefType === 1,
      coefLog2Denom: coefType === 0 ? b.ue() : 32,
      blBitDepth: 0,
      elBitDepth: 0,
      disableResidual: false,
    };
    b.bits(2); // vdr_rpu_normalized_idc
    b.bit(); // bl_video_full_range_flag
    if ((rpuFormat & 0x700) !== 0) throw new Error('Unsupported RPU format');
    h.blBitDepth = b.ue() + 8;
    h.elBitDepth = (b.ue() & 0xff) + 8;
    b.ue(); // vdr_bit_depth_minus8
    b.bit(); // spatial_resampling_filter_flag
    const dmCompression = b.bits(3);
    b.bit(); // el_spatial_resampling_filter_flag
    h.disableResidual = !!b.bit();
    const dmPresent = !!b.bit();
    if (dmCompression > 1) throw new Error('Unsupported DM compression');
    const usePrev = !!b.bit();
    const useNlq = !h.disableResidual;

    let mapping: Mapping;
    if (usePrev) {
      let id = b.ue();
      if (!this.vdr[id]) id = 0;
      const prev = this.vdr[id];
      if (!prev) throw new Error('Unknown previous RPU');
      mapping = prev;
    } else {
      const id = b.ue();
      if (id > 15) throw new Error('Bad RPU id');
      b.ue(); // mapping_color_space
      b.ue(); // mapping_chroma_format_idc
      const pivots: number[][] = [];
      for (let c = 0; c < 3; c++) {
        const n = b.ue() + 2;
        if (n > 9) throw new Error('Too many pivots');
        let pivot = 0;
        const list: number[] = [];
        for (let i = 0; i < n; i++) {
          pivot += b.bits(h.blBitDepth);
          list.push(Math.min(pivot, 0xffff));
        }
        pivots.push(list);
      }
      let nlqMethod = 0;
      if (useNlq) {
        nlqMethod = b.bits(3);
        b.bits(h.blBitDepth);
        b.bits(h.blBitDepth);
      }
      b.ue(); // num_x_partitions_minus1
      b.ue(); // num_y_partitions_minus1
      const comp: ReshapeComponent[] = [];
      for (let c = 0; c < 3; c++) {
        const list = pivots[c];
        const k: ReshapeComponent = {
          pivots: list.map((p) => p / 2 ** h.blBitDepth),
          method: [],
          poly: [],
          mmrOrder: [],
          mmrConstant: [],
          mmr: [],
        };
        for (let i = 0; i < list.length - 1; i++) {
          const idc = b.ue();
          if (idc > 1) throw new Error('Unknown mapping');
          k.method.push(idc);
          if (idc === 0) {
            const orderMinus1 = b.ue();
            if (orderMinus1 > 1) throw new Error('Bad polynomial order');
            if (orderMinus1 === 0 && b.bit())
              throw new Error('Unsupported linear interpolation');
            const p: [number, number, number] = [0, 0, 0];
            for (let j = 0; j <= orderMinus1 + 1; j++) p[j] = coef(b, h, true);
            k.poly.push(p);
            k.mmrOrder.push(0);
            k.mmrConstant.push(0);
            k.mmr.push([]);
          } else {
            const order = b.bits(2) + 1;
            if (order > 3) throw new Error('Bad MMR order');
            k.poly.push([0, 0, 0]);
            k.mmrOrder.push(order);
            k.mmrConstant.push(coef(b, h, true));
            const m: number[][] = [];
            for (let j = 0; j < order; j++) {
              const row: number[] = [];
              for (let q = 0; q < 7; q++) row.push(coef(b, h, true));
              m.push(row);
            }
            k.mmr.push(m);
          }
        }
        comp.push(k);
      }
      if (useNlq) {
        for (let c = 0; c < 3; c++) {
          b.bits(h.elBitDepth); // nlq_offset
          coef(b, h, false); // vdr_in_max
          if (nlqMethod === 0) {
            coef(b, h, false); // linear_deadzone_slope
            coef(b, h, false); // linear_deadzone_threshold
          }
        }
      }
      mapping = { comp };
      this.vdr[id] = mapping;
    }

    let color: Color;
    if (dmPresent) {
      const affected = b.ue();
      const current = b.ue();
      if (affected !== current) throw new Error('Unsupported DM ids');
      b.ue(); // scene_refresh_flag
      if (!dmCompression || !this.dm) {
        const nonlinear: number[] = [];
        for (let i = 0; i < 9; i++) nonlinear.push(b.sbits(16) / 8192);
        const nonlinearOffset: number[] = [];
        for (let i = 0; i < 3; i++) nonlinearOffset.push(b.bits(32) / 2 ** 28);
        const linear: number[] = [];
        for (let i = 0; i < 9; i++) linear.push(b.sbits(16) / 16384);
        b.bits(16); // signal_eotf
        b.bits(16);
        b.bits(16);
        b.bits(32); // signal_eotf_param0..2
        b.bits(5); // signal_bit_depth
        b.bits(2); // signal_color_space
        b.bits(2); // signal_chroma_format
        b.bits(2); // signal_full_range_flag
        const minPq = b.bits(12) / 4095;
        const maxPq = b.bits(12) / 4095;
        this.dm = {
          nonlinear,
          nonlinearOffset: nonlinearOffset as [number, number, number],
          linear,
          minPq,
          maxPq,
        };
      }
      color = this.dm;
      // Extension blocks (display management) follow: not used here.
    } else {
      color = DEFAULT_COLOR;
    }
    return { ...color, comp: mapping.comp };
  }
}
