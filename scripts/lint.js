#!/usr/bin/env node
// Style and hygiene gate.
//
// Stands in for `cargo fmt --check` plus `cargo clippy -- -D warnings`: every
// finding is an error, and any finding fails the run.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { readdirSync, statSync, readFileSync } from 'node:fs';

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

const files = ['src', 'bin', 'test', 'harness', 'scripts'].flatMap((d) => walk(join(root, d)));
const findings = [];

// Assembled from fragments so this file does not trip its own rules.
const BANNED = [
  [new RegExp(`\\b${'debug' + 'ger'}\\b`), 'leftover breakpoint statement'],
  [new RegExp(`\\b(it|test|describe)\\.${'on' + 'ly'}\\(`), 'focused test'],
  [new RegExp(`\\b${'va' + 'r'}\\s`), 'legacy var-style declaration'],
];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const name = relative(root, file);

  if (text.includes('\r\n')) findings.push(`${name}: CRLF line endings`);
  if (text.length > 0 && !text.endsWith('\n')) findings.push(`${name}: missing final newline`);

  text.split('\n').forEach((line, i) => {
    const at = `${name}:${i + 1}`;
    if (line.includes('\t')) findings.push(`${at}: literal tab`);
    if (/[ \t]+$/.test(line)) findings.push(`${at}: trailing whitespace`);
    for (const [pattern, message] of BANNED) {
      if (pattern.test(line)) findings.push(`${at}: ${message}`);
    }
  });
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(`\n${findings.length} finding(s)`);
  process.exit(1);
}

console.log(`lint ok: ${files.length} files clean`);
