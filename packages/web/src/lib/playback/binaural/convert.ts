/*
 * Converts the transcoder's TrueHD DASH audio to binaural FLAC, segment by segment, with the
 * renderer (atmos-render as WebAssembly). Runs in a worker; kept free of worker APIs so it can be
 * tested on its own.
 *
 * Timing: the renderer's output lags its input by its latency at the start of a session, and
 * carries on continuously after that, so each output fragment is stamped with the source time
 * its first rendered sample belongs to. A segment that doesn't follow the last one (a seek)
 * starts a new session there.
 */
import { FLAC_BLOCK, FLAC_MIN_BLOCK, FLAC_RATE, flacFrame } from './flac';
import { flacFragment, flacInit, initTimescale, readFragments } from './fmp4';

/** The renderer's exports (src/wasm.rs). */
export interface RendererExports {
  memory: WebAssembly.Memory;
  ar_alloc(len: number): number;
  ar_free(ptr: number, len: number): void;
  ar_new(windowsModes: number): number;
  ar_drop(session: number): void;
  ar_push(session: number, ptr: number, len: number): number;
  ar_output(session: number): number;
}

export class BinauralConverter {
  private timescale = FLAC_RATE;
  private session = 0;
  /** The next source sample expected (48 kHz), if a session is running. */
  private expected: number | null = null;
  /** Where the next output sample belongs (48 kHz). */
  private outPos = 0;
  /** Output under one FLAC frame's minimum, carried to the next segment. */
  private carry = new Float32Array(0);
  private sequence = 1;

  constructor(private readonly r: RendererExports) {}

  /** The init segment's replacement. */
  init(data: Uint8Array): Uint8Array {
    this.timescale = initTimescale(data) ?? FLAC_RATE;
    return flacInit();
  }

  private restart(at: number) {
    if (this.session) this.r.ar_drop(this.session);
    this.session = this.r.ar_new(0);
    if (!this.session) throw new Error('The binaural renderer could not start');
    this.outPos = at;
    this.carry = new Float32Array(0);
  }

  /** A media segment's replacement: binaural FLAC, possibly empty. */
  segment(data: Uint8Array): Uint8Array {
    const rendered: Float32Array[] = [];
    let first: number | null = null;
    for (const fragment of readFragments(data)) {
      const start = Math.round((fragment.start * FLAC_RATE) / this.timescale);
      if (this.expected === null || Math.abs(start - this.expected) > 1) {
        this.restart(start);
      }
      first ??= this.outPos - this.carry.length / 2;
      let duration = 0;
      const bytes = fragment.samples.reduce((n, s) => n + s.data.length, 0);
      const ptr = this.r.ar_alloc(bytes);
      let at = ptr;
      for (const s of fragment.samples) {
        new Uint8Array(this.r.memory.buffer, at, s.data.length).set(s.data);
        at += s.data.length;
        duration += s.duration;
      }
      const frames = this.r.ar_push(this.session, ptr, bytes);
      this.r.ar_free(ptr, bytes);
      if (frames > 0) {
        rendered.push(
          new Float32Array(
            this.r.memory.buffer,
            this.r.ar_output(this.session),
            frames * 2
          ).slice()
        );
      }
      this.expected =
        start + Math.round((duration * FLAC_RATE) / this.timescale);
    }
    if (first === null) return new Uint8Array(0);
    // The carried samples first, then what this segment rendered.
    const total =
      this.carry.length + rendered.reduce((n, r) => n + r.length, 0);
    const all = new Float32Array(total);
    all.set(this.carry);
    let at = this.carry.length;
    for (const r of rendered) {
      all.set(r, at);
      at += r.length;
    }
    const count = total / 2;
    // FLAC frames of FLAC_BLOCK; a tail under the minimum joins the frame before it, or, with
    // none, waits for the next segment.
    const frames: { data: Uint8Array; samples: number }[] = [];
    let pos = 0;
    while (count - pos >= FLAC_MIN_BLOCK) {
      let n = Math.min(FLAC_BLOCK, count - pos);
      if (count - pos - n < FLAC_MIN_BLOCK) n = count - pos;
      frames.push({
        data: flacFrame(all.subarray(2 * pos, 2 * (pos + n)), first + pos),
        samples: n,
      });
      pos += n;
    }
    this.carry = all.slice(2 * pos);
    this.outPos = first + count;
    if (!frames.length) return new Uint8Array(0);
    return flacFragment(this.sequence++, first, frames);
  }

  close() {
    if (this.session) this.r.ar_drop(this.session);
    this.session = 0;
  }
}
