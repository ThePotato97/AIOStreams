#!/usr/bin/env node
// Writes a package's header into its module, as the WebGPU player's decoder packages carry it: a
// custom section named `webgpu-player.decoder` holding the `//!` header (its docs/src/decoder-packages.md).
// The header is the one src/package.rs declares for the package's codec, so the two can't drift.
// Usage: pack.mjs <src/package.rs> <id: truehd | eac3 | dts> <module.wasm> <out package.wasm>
import { readFileSync, writeFileSync } from 'node:fs';

const SECTION = 'webgpu-player.decoder';
const [source, id, modulePath, out] = process.argv.slice(2);

// Each codec's `pub const HEADER: &str = "\ ... ";`, found by its `//! id:` line.
const headers = [...readFileSync(source, 'utf8').matchAll(/pub const HEADER: &str = "\\\n([\s\S]*?)";/g)].map((m) => m[1]);
const header = headers.find((h) => h.startsWith(`//! id: ${id}\n`));
if (!header) throw new Error(`${source} declares no header for ${id}`);

const leb = (value) => {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
};
const name = Buffer.from(SECTION);
const payload = Buffer.concat([leb(name.length), name, Buffer.from(header)]);
const module = readFileSync(modulePath);
if (module.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error(`${modulePath} is not WebAssembly`);
writeFileSync(out, Buffer.concat([module, Buffer.from([0]), leb(payload.length), payload]));
console.log(`packed ${id} (${header.split('\n')[1].replace('//! name: ', '')}) into ${out}`);
