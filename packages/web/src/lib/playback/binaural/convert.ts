/*
 * Converts the transcoder's TrueHD, E-AC-3, AC-3 or DTS DASH audio to FLAC, segment by segment: the
 * binaural render (atmos-render as WebAssembly; for E-AC-3 and AC-3 a core decoder, libav.js,
 * eac3-core.ts, decodes the core the renderer's JOC rebuilds the objects from; for DTS it decodes
 * the channels the renderer takes as they are) and the speaker version the transcoder
 * would send with headphones off (speakers.ts), together in each frame where they fit, so the page
 * switches between them at once. Runs in a worker; kept free of worker APIs so it can be tested on
 * its own.
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
import { SpeakerMix, type SpeakerLayout } from './speakers';

/**
 * What the converted audio carries: the binaural pair and the speaker version together (binaural
 * first), or one of them, where both would pass FLAC's 8 channels or the page can't pick a pair.
 */
export type OutputContents = 'both' | 'binaural' | 'speakers';

export interface OutputPlan {
  /** The renderer's modes (wasm.rs): 0 the stream's, 1 every element Near, 2 every element Far. */
  modes: number;
  /** The speaker version's layout, the transcoder's for this track and output. */
  layout: SpeakerLayout;
  contents: OutputContents;
  /**
   * Elements switched off in the debug view (indices in the snapshots' order), rendered as
   * silence in the binaural render; the speaker version isn't object-based and keeps them all.
   */
  disabled?: number[];
}

/** FLAC's most channels. */
export const MAX_CHANNELS = 8;

/** The renderer's exports (src/wasm.rs). */
export interface RendererExports {
  memory: WebAssembly.Memory;
  ar_alloc(len: number): number;
  ar_free(ptr: number, len: number): void;
  ar_new(modes: number): number;
  ar_new_eac3(modes: number, windowsLoudness: number): number;
  ar_new_decoded(modes: number): number;
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
  ar_disable(session: number, ptr: number, len: number): void;
  ar_debug_len(session: number): number;
  ar_debug_data(session: number): number;
  ar_speakers_len(session: number): number;
  ar_speakers(session: number): number;
  ar_speaker_channels(session: number): number;
  ar_speaker_mask(session: number): number;
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
  /** Decoded codecs: decoded again with FFmpeg's default options, as the transcoder decodes them. */
  private speakerDecoder: CoreDecoder | null = null;
  private readonly mix: SpeakerMix;
  /** Channels in each output frame. */
  readonly channels: number;
  /** Speaker samples (mixed) not yet matched with binaural output, oldest first. */
  private speakerQueue: Float32Array[] = [];
  private queued = 0;

  /**
   * `cores`: E-AC-3, AC-3 and DTS, with new decoders for each session (one set up for the renderer,
   * one with FFmpeg's defaults for the speaker version) and the renderer session they feed (`eac3`:
   * the Dolby core, its metadata read from the bytes; `decoded`: channels alone); without, TrueHD.
   */
  constructor(
    private readonly r: RendererExports,
    readonly plan: OutputPlan,
    private readonly cores?: {
      session: 'eac3' | 'decoded';
      render: () => CoreDecoder;
      speakers: () => CoreDecoder;
    }
  ) {
    this.mix = new SpeakerMix(plan.layout);
    this.channels =
      (plan.contents === 'speakers' ? 0 : 2) +
      (plan.contents === 'binaural' ? 0 : this.mix.channels);
    if (this.channels > MAX_CHANNELS)
      throw new Error(`${this.channels} channels don't fit in FLAC`);
  }

  private get speakers() {
    return this.plan.contents !== 'binaural';
  }

  /** The init segment's replacement. */
  init(data: Uint8Array): Uint8Array {
    this.timescale = initTimescale(data) ?? FLAC_RATE;
    return flacInit(this.channels);
  }

  private restart(at: number) {
    if (this.session) this.r.ar_drop(this.session);
    // The Reference Player's loudness, as the transcoder's renderer.
    this.session = !this.cores
      ? this.r.ar_new(this.plan.modes)
      : this.cores.session === 'decoded'
        ? this.r.ar_new_decoded(this.plan.modes)
        : this.r.ar_new_eac3(this.plan.modes, 0);
    if (!this.session) throw new Error('The binaural renderer could not start');
    // A new session starts from fresh decoders, as the transcoder starts a new FFmpeg.
    this.decoder?.close();
    this.decoder = this.cores?.render() ?? null;
    this.speakerDecoder?.close();
    this.speakerDecoder = (this.speakers && this.cores?.speakers()) || null;
    this.speakerQueue = [];
    this.queued = 0;
    this.outPos = at;
    this.sessionStart = at;
    this.r.ar_debug(this.session, 1);
    const off = this.plan.disabled ?? [];
    if (off.length) {
      const bytes = off.length * 4;
      const ptr = this.r.ar_alloc(bytes);
      new Uint32Array(this.r.memory.buffer, ptr, off.length).set(off);
      this.r.ar_disable(this.session, ptr, off.length);
      this.r.ar_free(ptr, bytes);
    }
    this.carry = new Float32Array(0);
  }

  /** Decoded speaker channels (FFmpeg's order, `mask`), mixed to the layout and queued. */
  private queueSpeakers(pcm: Float32Array, channels: number, mask: bigint) {
    if (!this.speakers || !pcm.length) return;
    const mixed = this.mix.mix(pcm, channels, mask);
    this.speakerQueue.push(mixed);
    this.queued += mixed.length / this.mix.channels;
  }

  /** The next `frames` queued speaker frames. */
  private takeSpeakers(frames: number): Float32Array {
    if (frames > this.queued)
      throw new Error(
        `The speaker version fell behind the binaural render (${this.queued} of ${frames} samples)`
      );
    const n = this.mix.channels;
    const out = new Float32Array(frames * n);
    let at = 0;
    while (at < out.length) {
      const head = this.speakerQueue[0];
      const take = Math.min(head.length, out.length - at);
      out.set(head.subarray(0, take), at);
      at += take;
      if (take === head.length) this.speakerQueue.shift();
      else this.speakerQueue[0] = head.subarray(take);
    }
    this.queued -= frames;
    return out;
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
      first ??= this.outPos - this.carry.length / this.channels;
      let duration = 0;
      const bytes = fragment.samples.reduce((n, s) => n + s.data.length, 0);
      const ptr = this.r.ar_alloc(bytes);
      let at = ptr;
      for (const s of fragment.samples) {
        new Uint8Array(this.r.memory.buffer, at, s.data.length).set(s.data);
        at += s.data.length;
        duration += s.duration;
      }
      const units = fragment.samples.map((s) => s.data);
      // Decoded codecs: the speaker version first, so it's queued before the render it goes with
      const speakers = this.speakerDecoder?.decode(units);
      if (speakers)
        this.queueSpeakers(
          speakers.pcm,
          speakers.channels,
          BigInt(speakers.mask)
        );
      const frames = this.r.ar_push(this.session, ptr, bytes);
      this.r.ar_free(ptr, bytes);
      // TrueHD: the speaker presentation the renderer's decoder gave for these bytes
      const len = this.r.ar_speakers_len(this.session);
      if (len)
        this.queueSpeakers(
          new Float32Array(
            this.r.memory.buffer,
            this.r.ar_speakers(this.session),
            len
          ).slice(),
          this.r.ar_speaker_channels(this.session),
          BigInt(Math.round(this.r.ar_speaker_mask(this.session)))
        );
      this.output(frames, rendered);
      const core = this.decoder?.decode(units);
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
    const count = total / this.channels;
    // FLAC frames of FLAC_BLOCK; a tail under the minimum joins the frame before it, or, with
    // none, waits for the next segment.
    const frames: { data: Uint8Array; samples: number }[] = [];
    let pos = 0;
    while (count - pos >= FLAC_MIN_BLOCK) {
      let n = Math.min(FLAC_BLOCK, count - pos);
      if (count - pos - n < FLAC_MIN_BLOCK) n = count - pos;
      const c = this.channels;
      frames.push({
        data: flacFrame(all.subarray(c * pos, c * (pos + n)), first + pos, c),
        samples: n,
      });
      pos += n;
    }
    this.carry = all.slice(this.channels * pos);
    this.outPos = first + count;
    if (!frames.length) return new Uint8Array(0);
    return flacFragment(this.sequence++, first, frames);
  }

  /** Keeps the `frames` frames the last renderer call left, with their speaker samples. */
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
    if (frames <= 0) return;
    const binaural = new Float32Array(
      this.r.memory.buffer,
      this.r.ar_output(this.session),
      frames * 2
    );
    if (this.plan.contents === 'binaural') {
      rendered.push(binaural.slice());
      return;
    }
    const speakers = this.takeSpeakers(frames);
    if (this.plan.contents === 'speakers') {
      rendered.push(speakers);
      return;
    }
    // binaural first, then the speaker channels
    const n = this.mix.channels;
    const c = this.channels;
    const out = new Float32Array(frames * c);
    for (let f = 0; f < frames; f++) {
      out[f * c] = binaural[2 * f];
      out[f * c + 1] = binaural[2 * f + 1];
      for (let i = 0; i < n; i++) out[f * c + 2 + i] = speakers[f * n + i];
    }
    rendered.push(out);
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
    this.speakerDecoder?.close();
    this.speakerDecoder = null;
  }
}
