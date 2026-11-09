/*
 * Loads the E-AC-3, AC-3 and DTS decoders' libav.js (scripts/build-libav-eac3.sh; not committed, so the
 * build picks libav-eac3-missing.ts without it). In the binaural worker, in "direct" mode: its
 * calls run synchronously there, off the page's thread.
 */
// @ts-expect-error -- built by scripts/build-libav-eac3.sh, untyped (eac3-core.ts types what's used)
import LibAV from './libav/libav.mjs';
// @ts-expect-error -- as above
import factory from './libav/libav.factory.mjs';
import type { LibAVSync } from './eac3-core';

export const loadLibav: (() => Promise<LibAVSync>) | null = () =>
  (
    LibAV as {
      LibAV(options: object): Promise<LibAVSync>;
    }
  ).LibAV({
    noworker: true,
    factory,
    wasmurl: new URL('./libav/libav.wasm', import.meta.url).href,
  });
