/*
 * Converts the transcoder's TrueHD or E-AC-3 DASH audio to binaural FLAC, segment by segment,
 * with the renderer (atmos-render as WebAssembly); for E-AC-3 a core decoder (libav.js,
 * eac3-core.ts) decodes the core the renderer's JOC rebuilds the objects from. Runs in a worker;
 * kept free of worker APIs so it can be tested on its own.
 *
 * Timing: the renderer's output lags its input by its latency at the start of a session, and
 * carries on continuously after that, so each output fragment is stamped with the source time
 * its first rendered sample belongs to. A segment that doesn't follow the last one (a seek)
 * starts a new session there.
 */
import { FLAC_BLOCK, FLAC_MIN_BLOCK, FLAC_RATE, flacFrame } from './flac';
import { flacFragment, flacInit, initTimescale, readFragments } from './fmp4';
import type { CoreDecoder } from './eac3-core';
import { readSnapshots, type SceneSnapshot } from './objects';

/** The renderer's exports (src/wasm.rs). */
export interface RendererExports {
  memory: WebAssembly.Memory;
  ar_alloc(len: number): number;
  ar_free(ptr: number, len: number): void;
  ar_new(windowsModes: number): number;
  ar_new_eac3(windowsModes: number, windowsLoudness: number): number;
  ar_drop(session: number): void;
  ar_push(session: number, ptr: number, len: number): number;
  ar_push_pcm(
    session: number,
    ptr: number,
    len: number,
    channels: number,
    mask: number
  ): number;
  ar_output(session: number): number;
  ar_debug(session: number, on: number): void;
  ar_debug_len(session: number): number;
  ar_debug_data(session: number): number;
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
  /** Stream time of the session's first sample (48 kHz). */
  private sessionStart = 0;
  /** The renderer's scene snapshots since `takeSnapshots` (the debug view). */
  private snapshots: SceneSnapshot[] = [];
  private decoder: CoreDecoder | null = null;

  /** `core`: E-AC-3, with a new core decoder for each session; without, TrueHD. */
  constructor(
    private readonly r: RendererExports,
    private readonly core?: () => CoreDecoder
  ) {}

  /** The init segment's replacement. */
  init(data: Uint8Array): Uint8Array {
    this.timescale = initTimescale(data) ?? FLAC_RATE;
    return flacInit();
  }

  private restart(at: number) {
    if (this.session) this.r.ar_drop(this.session);
    // The transcoder's defaults: the stream's render modes, the Reference Player's loudness.
    this.session = this.core ? this.r.ar_new_eac3(0, 0) : this.r.ar_new(0);
    if (!this.session) throw new Error('The binaural renderer could not start');
    // A new session starts from a fresh decoder, as the transcoder's renderer starts a new FFmpeg.
    this.decoder?.close();
    this.decoder = this.core?.() ?? null;
    this.outPos = at;
    this.sessionStart = at;
    this.r.ar_debug(this.session, 1);
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
      this.output(this.r.ar_push(this.session, ptr, bytes), rendered);
      this.r.ar_free(ptr, bytes);
      const core = this.decoder?.decode(fragment.samples.map((s) => s.data));
      if (core) this.pushCore(core.pcm, core.channels, core.mask, rendered);
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

  /** Keeps the `frames` stereo frames the last renderer call left. */
  private output(frames: number, rendered: Float32Array[]) {
    const len = this.r.ar_debug_len(this.session);
    if (len)
      this.snapshots.push(
        ...readSnapshots(
          new Float64Array(
            this.r.memory.buffer,
            this.r.ar_debug_data(this.session),
            len
          ),
          this.sessionStart / FLAC_RATE,
          FLAC_RATE
        )
      );
    if (frames > 0)
      rendered.push(
        new Float32Array(
          this.r.memory.buffer,
          this.r.ar_output(this.session),
          frames * 2
        ).slice()
      );
  }

  private pushCore(
    pcm: Float32Array,
    channels: number,
    mask: number,
    rendered: Float32Array[]
  ) {
    // ar_alloc gives bytes: aligned here for f32
    const bytes = pcm.length * 4 + 4;
    const raw = this.r.ar_alloc(bytes);
    const ptr = (raw + 3) & ~3;
    new Float32Array(this.r.memory.buffer, ptr, pcm.length).set(pcm);
    const frames = this.r.ar_push_pcm(
      this.session,
      ptr,
      pcm.length,
      channels,
      mask >>> 0
    );
    this.r.ar_free(raw, bytes);
    this.output(frames, rendered);
  }

  /** The scene snapshots taken since the last call. */
  takeSnapshots(): SceneSnapshot[] {
    const out = this.snapshots;
    this.snapshots = [];
    return out;
  }

  close() {
    if (this.session) this.r.ar_drop(this.session);
    this.session = 0;
    this.decoder?.close();
    this.decoder = null;
  }
}
