// Differential verification: the compiled Rust capsule (oracle) versus
// the migrated JavaScript capsule, over the fixture corpus.
//
// Both sides run the same scenarios against the same in-memory world
// (`world.mjs`) and produce the same trace shape. Every observable
// channel is compared SEPARATELY so a failure names the exact channel:
//
//   result.action   the `capsule-result` action ("continue" / "deny")
//   result.data     the `capsule-result` payload string
//   publishes       ordered IPC topic/payload pairs, including failed ones
//   logs            ordered log level/message records
//   world.kv        final KV contents
//   world.files     final virtual filesystem contents
//
// The oracle wasm is built from the untouched Rust source:
//
//   cargo build --release        # inside the pristine Rust checkout
//
// and located through ASTRID_ORACLE_WASM, defaulting to the staging copy
// used during the migration.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runScenario as runOracle } from './oracle.mjs';
import { runScenario as runPort } from './js-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, 'corpus');
const DEFAULT_WASM = '/tmp/capsule-migration/oracle/target/wasm32-unknown-unknown/release/astrid_capsule_identity.wasm';
const WASM = process.env.ASTRID_ORACLE_WASM ?? DEFAULT_WASM;

/**
 * Compare two JSON-shaped values, collecting a path-qualified list of
 * differences instead of stopping at the first one.
 *
 * @param {string} where dotted path of the current node
 * @param {unknown} expected value from the Rust oracle
 * @param {unknown} actual value from the JavaScript port
 * @param {string[]} out accumulator
 */
function diff(where, expected, actual, out) {
  if (expected === actual) return;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push(`${where}: length ${expected.length} (rust) != ${actual.length} (js)`);
    }
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i += 1) diff(`${where}[${i}]`, expected[i], actual[i], out);
    return;
  }

  const bothObjects =
    expected !== null && actual !== null &&
    typeof expected === 'object' && typeof actual === 'object' &&
    !Array.isArray(expected) && !Array.isArray(actual);

  if (bothObjects) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      diff(`${where}.${key}`, expected[key], actual[key], out);
    }
    return;
  }

  out.push(`${where}: ${JSON.stringify(expected)} (rust) != ${JSON.stringify(actual)} (js)`);
}

/**
 * Compare one scenario's traces channel by channel.
 *
 * @returns {string[]} failures, empty when the traces match
 */
function compareTraces(rust, js) {
  /** @type {string[]} */
  const failures = [];

  if (rust.calls.length !== js.calls.length) {
    failures.push(`calls: ${rust.calls.length} (rust) != ${js.calls.length} (js)`);
  }

  const n = Math.max(rust.calls.length, js.calls.length);
  for (let i = 0; i < n; i += 1) {
    const r = rust.calls[i];
    const j = js.calls[i];
    const label = `call[${i}]${r ? ` ${r.action}` : ''}`;
    if (r === undefined || j === undefined) {
      failures.push(`${label}: present on only one side`);
      continue;
    }
    diff(`${label}.trapped`, r.trapped ?? null, j.trapped ?? null, failures);
    diff(`${label}.result.action`, r.result?.action ?? null, j.result?.action ?? null, failures);
    diff(`${label}.result.data`, r.result?.data ?? null, j.result?.data ?? null, failures);
    diff(`${label}.publishes`, r.publishes ?? [], j.publishes ?? [], failures);
    diff(`${label}.logs`, r.logs ?? [], j.logs ?? [], failures);
  }

  diff('world.kv', rust.world.kv, js.world.kv, failures);
  diff('world.files', rust.world.files, js.world.files, failures);

  return failures;
}

async function main() {
  if (!fs.existsSync(WASM)) {
    process.stderr.write(
      `oracle wasm not found at ${WASM}\n` +
      'build it from the pristine Rust checkout with `cargo build --release`\n' +
      'and point ASTRID_ORACLE_WASM at the resulting .wasm file.\n',
    );
    return 2;
  }

  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    process.stderr.write(`no fixtures found in ${CORPUS_DIR}\n`);
    return 2;
  }

  let passed = 0;
  /** @type {Array<{name: string, failures: string[]}>} */
  const failed = [];

  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const scenario = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8'));

    let failures;
    try {
      const [rust, js] = [await runOracle(WASM, scenario), await runPort(scenario)];
      failures = compareTraces(rust, js);
    } catch (error) {
      failures = [`harness error: ${error && error.stack ? error.stack : String(error)}`];
    }

    if (failures.length === 0) {
      passed += 1;
      process.stdout.write(`PASS ${name}\n`);
    } else {
      failed.push({ name, failures });
      process.stdout.write(`FAIL ${name}\n`);
      for (const failure of failures) process.stdout.write(`       ${failure}\n`);
    }
  }

  process.stdout.write(`\n${passed}/${files.length} scenarios matched the Rust oracle\n`);
  if (failed.length > 0) {
    process.stdout.write(`failing scenarios: ${failed.map((f) => f.name).join(', ')}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
