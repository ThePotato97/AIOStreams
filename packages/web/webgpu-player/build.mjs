#!/usr/bin/env node
// Builds the WebGPU player the web app serves: the published @aiostreams/webgpu-player assets, with
// the engine's JavaScript (its embedding facade and its workers) rebuilt from its source at the
// pinned revision (engine.json) with this fork's patches (patches/*.patch), and our audio decoder
// packages (atmos-render's: truehd, eac3, dts) in place of the engine's own.
//
// The engine's WebAssembly (its output stage, libdovi, its video decoder packages) is used as
// published: none of the patches touch it, and rebuilding the facade and workers from the
// unpatched source gives the published files byte for byte. So the build needs Node and Git only.
//
// The web app's build (rsbuild.config.ts) serves dist/libraries when dist/version.json exists, and
// the published package otherwise.
//
// Usage: node build.mjs --packages <dir with truehd.wasm, eac3.wasm, dts.wasm and their notices>
//                       [--engine <an engine checkout to use as it stands, patches already in it>]
//                       [--published <the published package's tarball, in place of the installed one>]
// The published package is the one packages/web installed, or a tarball (`npm pack`) that must match
// the integrity pnpm-lock.yaml records for it, as the Docker build gives it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
/** The engine's checkout and the unpacked published package: outside the repository, where its test runner and git
 * don't look, and not under a node_modules (whose files esbuild doesn't give the engine's tsconfig paths). */
const CACHE = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'aiostreams-webgpu-player'
);
const PIN = JSON.parse(readFileSync(join(HERE, 'engine.json'), 'utf8'));
/** Our packages, by the name the facade loads them under. */
const OUR_PACKAGES = ['truehd.wasm', 'eac3.wasm', 'dts.wasm'];
const ASSET_KEY_LENGTH = 16;

const { values } = parseArgs({
  options: {
    packages: { type: 'string' },
    engine: { type: 'string' },
    published: { type: 'string' },
  },
  strict: true,
});
if (!values.packages) throw new Error('--packages <dir> is required');

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });
const output = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();

/** The engine's source at the pinned revision, its Mediabunny fork with it. */
function checkout() {
  if (values.engine) return values.engine;
  const engine = join(CACHE, 'engine');
  if (!existsSync(join(engine, '.git'))) {
    rmSync(engine, { force: true, recursive: true });
    mkdirSync(dirname(engine), { recursive: true });
    run('git', [
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      PIN.tag,
      PIN.repository,
      engine,
    ]);
  }
  const head = output('git', ['rev-parse', 'HEAD'], engine);
  if (head !== PIN.commit)
    throw new Error(`${PIN.tag} is ${head}, not the pinned ${PIN.commit}`);
  run(
    'git',
    ['submodule', 'update', '--init', '--depth', '50', 'vendor/mediabunny'],
    engine
  );
  const fork = output(
    'git',
    ['rev-parse', 'HEAD'],
    join(engine, 'vendor', 'mediabunny')
  );
  if (fork !== PIN.mediabunny)
    throw new Error(`Mediabunny is ${fork}, not the pinned ${PIN.mediabunny}`);
  return engine;
}

const patches = readdirSync(join(HERE, 'patches'))
  .filter((name) => name.endsWith('.patch'))
  .sort();

/**
 * Applies our patches to the build's own clone, from a clean tree, so a build after a change of
 * patch starts from the source. A checkout given with --engine is used as it stands.
 */
function patch(engine) {
  if (values.engine) return;
  run('git', ['reset', '--hard', '--quiet'], engine);
  run(
    'git',
    ['clean', '-d', '--force', '--quiet', '--', 'src', 'test'],
    engine
  );
  for (const name of patches)
    run(
      'git',
      ['apply', '--whitespace=nowarn', join(HERE, 'patches', name)],
      engine
    );
}

/** Every file under `root`, relative and sorted. */
function files(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
    )
    .sort();
}

const publishedDirectory = publishedPackage();
const engine = checkout();
patch(engine);
// The engine's toolchain: esbuild, and the Mediabunny fork the facade and workers bundle.
if (!existsSync(join(engine, 'node_modules', 'esbuild')))
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], engine);
run('node', ['scripts/mediabunny.mjs'], engine);

/** The published package's directory: the installed one, or the tarball's, checked against the lockfile. */
function publishedPackage() {
  if (!values.published)
    return dirname(
      createRequire(join(HERE, '..', 'package.json')).resolve(
        '@aiostreams/webgpu-player/package.json'
      )
    );
  const version = PIN.tag.replace(/^v/u, '');
  const lock = readFileSync(
    join(HERE, '..', '..', '..', 'pnpm-lock.yaml'),
    'utf8'
  );
  const entry = lock.match(
    new RegExp(
      `\n  '@aiostreams/webgpu-player@${version.replaceAll('.', '\\.')}':\n    resolution: \\{integrity: (sha512-[^}]+)\\}`,
      'u'
    )
  );
  if (!entry)
    throw new Error(
      `pnpm-lock.yaml has no @aiostreams/webgpu-player@${version}`
    );
  const integrity = `sha512-${createHash('sha512').update(readFileSync(values.published)).digest('base64')}`;
  if (integrity !== entry[1])
    throw new Error(
      `${values.published} is ${integrity}, not pnpm-lock.yaml's ${entry[1]}`
    );
  const unpacked = join(CACHE, 'published');
  rmSync(unpacked, { force: true, recursive: true });
  mkdirSync(unpacked, { recursive: true });
  run('tar', [
    '-xzf',
    values.published,
    '-C',
    unpacked,
    '--strip-components=1',
  ]);
  return unpacked;
}

// The published assets, then our packages and their notices in place of the engine's own.
const published = join(publishedDirectory, 'libraries');
const libraries = join(DIST, 'libraries');
rmSync(DIST, { force: true, recursive: true });
cpSync(published, libraries, { recursive: true });
for (const name of readdirSync(values.packages)) {
  const known = OUR_PACKAGES.includes(name) || !name.endsWith('.wasm');
  if (known)
    copyFileSync(join(values.packages, name), join(libraries, 'wgpud', name));
}
for (const name of OUR_PACKAGES)
  if (!existsSync(join(values.packages, name)))
    throw new Error(`${name} is missing from ${values.packages}`);
// Each passes the engine's own package loader, as the player will load it.
const { checkDecoderPackage } = await import(
  join(engine, 'tools', 'decoder-package-format.mjs')
);
for (const name of OUR_PACKAGES) {
  const { manifest } = await checkDecoderPackage(
    readFileSync(join(libraries, 'wgpud', name))
  );
  console.log(
    `webgpu-player: ${name} loads as ${manifest.id} (${manifest.name}), codecs ${manifest.codecs.join(', ')}`
  );
}

// Every served file but the JavaScript rebuilt below keys the build, so a browser that holds an
// earlier one asks again.
const { build } = createRequire(join(engine, 'package.json'))('esbuild');
const { getWorkerEntryPoints } = await import(
  join(engine, 'scripts', 'library-assets.mjs')
);
const rebuilt = new Set([
  'webgpu-player/EmbeddedPlayer.js',
  ...getWorkerEntryPoints().map(([destination]) => destination),
]);
const hash = createHash('sha256');
for (const file of files(libraries).filter((f) => !rebuilt.has(f))) {
  hash.update(file);
  hash.update('\0');
  hash.update(readFileSync(join(libraries, file)));
}
for (const name of patches)
  hash.update(readFileSync(join(HERE, 'patches', name)));
const assetKey = hash.digest('hex').slice(0, ASSET_KEY_LENGTH);

// The workers and the facade, with the engine's own esbuild options (scripts/build.mjs and
// scripts/build-embed.mjs, production).
await build({
  absWorkingDir: engine,
  bundle: true,
  entryPoints: getWorkerEntryPoints().map(([destination, source]) => ({
    in: source,
    out: destination.replace(/\.js$/u, ''),
  })),
  format: 'iife',
  logLevel: 'warning',
  minify: true,
  outdir: libraries,
  platform: 'browser',
  sourcemap: false,
  target: 'es2022',
});
const decoderPackages = readdirSync(join(libraries, 'wgpud'))
  .filter((name) => name.endsWith('.wasm'))
  .sort();
await build({
  absWorkingDir: engine,
  bundle: true,
  define: {
    __WEBGPU_PLAYER_ASSET_KEY__: JSON.stringify(assetKey),
    __WEBGPU_PLAYER_DECODER_PACKAGES__: JSON.stringify(decoderPackages),
  },
  entryPoints: [join(engine, 'src', 'embed', 'EmbeddedPlayer.ts')],
  format: 'esm',
  loader: { '.css': 'text' },
  logLevel: 'warning',
  minify: true,
  outfile: join(libraries, 'webgpu-player', 'EmbeddedPlayer.js'),
  platform: 'browser',
  sourcemap: false,
  target: 'es2022',
});

writeFileSync(
  join(DIST, 'version.json'),
  `${JSON.stringify({ engine: PIN.tag, commit: PIN.commit, patches, assetKey }, null, 2)}\n`
);
console.log(
  `webgpu-player: built ${PIN.tag} with ${patches.length} patches and our packages (key ${assetKey})`
);
