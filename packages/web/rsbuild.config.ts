import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { formatter } from '@lingui/format-po';
import {
  defineConfig,
  loadEnv,
  rspack,
  type RsbuildConfig,
} from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { LICENSES_FILE, pluginLicenses } from './licenses-plugin';

const { parsed } = loadEnv({ prefixes: ['PUBLIC_'] });

/**
 * The commit this build comes from, e.g. `a1b2c3d4 (2026-09-25)`: from git, or
 * from the metadata CI writes where there is none, as in the Docker build.
 */
function buildCommit(): string {
  try {
    const [hash, date] = execFileSync(
      'git',
      ['log', '-1', '--format=%h%n%cs', '--abbrev=8'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .trim()
      .split('\n');
    if (hash) return `${hash} (${date})`;
  } catch {}
  try {
    const { commitHash, commitTime } = JSON.parse(
      readFileSync(
        new URL('../../resources/metadata.json', import.meta.url),
        'utf8'
      )
    ) as { commitHash?: string; commitTime?: string };
    if (commitHash && commitHash !== 'unknown')
      return commitTime
        ? `${commitHash} (${commitTime.slice(0, 10)})`
        : commitHash;
  } catch {}
  return 'unknown';
}

/** How much of the template a language needs translated before the app offers it. */
const MIN_TRANSLATED = 0.5;

async function unfinishedLocales(): Promise<string[]> {
  const dir = new URL('./src/locales/', import.meta.url);
  const po = formatter({ lineNumbers: false });
  const read = async (filename: string) =>
    await po.parse(readFileSync(new URL(filename, dir), 'utf8'), {
      locale: filename.slice(0, filename.lastIndexOf('.')),
      sourceLocale: 'en-GB',
      filename,
    });
  // Counted against the template, as a catalog can trail it.
  const ids = Object.keys(await read('messages.pot'));
  const unfinished: string[] = [];
  for (const filename of readdirSync(dir).filter((f) => f.endsWith('.po'))) {
    const catalog = await read(filename);
    const translated = ids.filter((id) => {
      const message = catalog[id];
      const flags = message?.extra?.flags;
      return (
        message?.translation &&
        !(Array.isArray(flags) && flags.includes('fuzzy'))
      );
    }).length;
    if (translated < ids.length * MIN_TRANSLATED)
      unfinished.push(filename.slice(0, -'.po'.length));
  }
  return unfinished;
}

const devServerPort = Number(parsed.PORT) || 21459;
const backendBaseUrl =
  parsed.PUBLIC_BACKEND_BASE_URL || 'http://localhost:3001';

/** The page is served from every mount's `/web`, so its assets need one absolute home. */
const ASSET_PREFIX = '/jellyfin-web/';

const WEB_PAGE = /^\/jellyfin(\/.*)?\/web(\/(index\.html)?)?(\?|$)/i;

/** The icons a server would otherwise serve from its root. */
const BUNDLED_ICONS = [
  'logo.png',
  'favicon.ico',
  'icon0.svg',
  'apple-icon.png',
].map((name) => ({ from: `../frontend/public/${name}`, to: name }));

/**
 * The binaural renderer's WebAssembly (scripts/build-atmos-wasm.sh). Without it, binaural
 * rendering stays on the server.
 */
const BINAURAL = new URL('./src/lib/playback/binaural/', import.meta.url);
function atmosWasmUrl(): string {
  const built = existsSync(new URL('atmos_render.wasm', BINAURAL));
  return new URL(built ? 'wasm-url.ts' : 'wasm-url-missing.ts', BINAURAL)
    .pathname;
}

/**
 * FFmpeg's decoders for in-browser binaural rendering, libav.js (scripts/build-libav-eac3.sh), and
 * the codecs they decode, as the build lists them in decoders.json (one from before it did has
 * the AC-3/E-AC-3 decoder alone). Without it, those codecs' binaural rendering stays on the
 * server.
 */
const LIBAV_EAC3 = existsSync(new URL('libav/libav.wasm', BINAURAL));
const LIBAV_DECODERS: string[] = !LIBAV_EAC3
  ? []
  : existsSync(new URL('libav/decoders.json', BINAURAL))
    ? JSON.parse(readFileSync(new URL('libav/decoders.json', BINAURAL), 'utf8'))
    : ['eac3', 'ac3'];

/**
 * `--env-mode standalone` builds the app on its own, with a server list,
 * instead of the copy each server hosts at `/web`.
 */
export default defineConfig(async ({ envMode }) => {
  const standalone = envMode === 'standalone';
  const define = {
    // Read by @aiostreams/ui components.
    'process.env.NEXT_PUBLIC_PLATFORM': JSON.stringify(''),
    __STANDALONE__: JSON.stringify(standalone),
    __APP_COMMIT__: JSON.stringify(buildCommit()),
    __UNFINISHED_LOCALES__: JSON.stringify(await unfinishedLocales()),
    __LICENSES_FILE__: JSON.stringify(LICENSES_FILE),
    __LIBAV_DECODERS__: JSON.stringify(LIBAV_DECODERS),
  };
  const source = {
    entry: { index: './src/main.tsx' },
    define,
    // Dependencies too, which are otherwise shipped as published: older browsers can't parse some of their syntax.
    include: [/[\\/]node_modules[\\/]/],
  };
  const resolve = {
    alias: {
      'atmos-render-wasm-url': atmosWasmUrl(),
      'libav-eac3': new URL(
        LIBAV_EAC3 ? 'libav-eac3.ts' : 'libav-eac3-missing.ts',
        BINAURAL
      ).pathname,
    },
  };
  // Lingui's macros compile at build time, and each catalog loads compiled.
  const tools: RsbuildConfig['tools'] = {
    swc: { jsc: { experimental: { plugins: [['@lingui/swc-plugin', {}]] } } },
    rspack: {
      // libav.js's factory imports it only when it runs under Node.
      plugins: [new rspack.IgnorePlugin({ resourceRegExp: /^node:module$/ })],
      module: {
        rules: [
          { test: /\.po$/, use: '@lingui/loader' },
          // Emscripten's factory for libav.js: its own wasm URL (passed in instead) and its
          // Node-only imports stay as they are.
          {
            test: /[\\/]binaural[\\/]libav[\\/]libav\.factory\.mjs$/,
            parser: { url: false },
          },
        ],
      },
    },
  };
  if (standalone) {
    return {
      plugins: [pluginReact(), pluginLicenses()],
      source,
      resolve,
      tools,
      html: {
        template: './index.html',
        templateParameters: { root: './', icons: false },
      },
      output: {
        distPath: { root: 'dist-standalone' },
        // Relative, since the TV apps load it from their package's files.
        assetPrefix: 'auto',
        copy: BUNDLED_ICONS,
      },
      server: { port: devServerPort + 1 },
    };
  }
  return {
    plugins: [pluginReact(), pluginLicenses()],
    source,
    resolve,
    tools,
    html: {
      template: './index.html',
      templateParameters: { root: '/', icons: true },
    },
    output: { assetPrefix: ASSET_PREFIX },
    dev: { assetPrefix: ASSET_PREFIX },
    server: {
      port: devServerPort,
      proxy: {
        '/api': backendBaseUrl,
        '/party': { target: backendBaseUrl, ws: true },
        '/watch': { target: backendBaseUrl, bypass: () => '/index.html' },
        '/jellyfin': {
          target: backendBaseUrl,
          // The context matches by prefix, so it also catches this app's own assets.
          bypass: (req) => {
            const url = req.url ?? '';
            if (url.startsWith(ASSET_PREFIX)) return url;
            return WEB_PAGE.test(url) ? '/index.html' : undefined;
          },
        },
        '/logo.png': backendBaseUrl,
        '/favicon.ico': backendBaseUrl,
        '/icon0.svg': backendBaseUrl,
        '/apple-icon.png': backendBaseUrl,
      },
    },
  };
});
