#!/usr/bin/env node
// Build check for the capsule.
//
// The Rust crate compiled to a wasm cdylib, so `cargo build` was both the
// syntax check and the artifact step. JavaScript has no compile step, so the
// equivalent guarantee is: every module parses, every module actually loads,
// and the manifest still points at an entry point that exists.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [...walk(join(root, 'src')), ...walk(join(root, 'bin'))];

for (const file of files) {
  await import(`file://${file}`);
}

const manifest = await readFile(join(root, 'Capsule.toml'), 'utf8');
const entry = /^file = "(.+)"$/m.exec(manifest);
if (!entry) {
  console.error('Capsule.toml: no component `file` entry');
  process.exit(1);
}
if (!existsSync(join(root, entry[1]))) {
  console.error(`Capsule.toml: component file "${entry[1]}" does not exist`);
  process.exit(1);
}

console.log(`build ok: ${files.length} modules loaded, entry ${entry[1]}`);
