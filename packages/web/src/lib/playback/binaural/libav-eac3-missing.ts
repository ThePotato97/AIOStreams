/** libav.js wasn't built (scripts/build-libav-eac3.sh): E-AC-3, AC-3 and DTS binaural rendering stays on the server. */
import type { LibAVSync } from './eac3-core';

export const loadLibav: (() => Promise<LibAVSync>) | null = null;
