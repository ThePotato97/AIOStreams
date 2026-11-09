/// <reference types="@webgpu/types" />
/// <reference types="@rsbuild/core/types" />

/** True in the standalone build, which picks its server instead of being served by one. */
declare const __STANDALONE__: boolean;

/** The commit this build comes from, with its date. */
declare const __APP_COMMIT__: string;

/** The list of the npm packages in the bundle and their licences, under the public path. */
declare const __LICENSES_FILE__: string;

declare let __webpack_public_path__: string;

/** Languages with a catalog too little translated to offer. */
declare const __UNFINISHED_LOCALES__: string[];

/** A translation catalog, compiled by `@lingui/loader`. */
declare module '*.po' {
  import type { Messages } from '@lingui/core';
  export const messages: Messages;
}

/** The binaural renderer's WebAssembly URL, or null where it wasn't built (an rsbuild alias). */
declare module 'atmos-render-wasm-url' {
  export const wasmUrl: string | null;
}

/**
 * The codecs ("eac3", "ac3", "dts") the built libav.js decodes for binaural rendering in the page
 * (scripts/build-libav-eac3.sh); none where it wasn't built.
 */
declare const __LIBAV_DECODERS__: string[];

/** Loads that libav.js, or null where it wasn't built (an rsbuild alias). */
declare module 'libav-eac3' {
  import type { LibAVSync } from './lib/playback/binaural/eac3-core';
  export const loadLibav: (() => Promise<LibAVSync>) | null;
}
