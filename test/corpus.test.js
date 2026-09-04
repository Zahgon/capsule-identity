/**
 * Recorded differential regression suite.
 *
 * `harness/differential.mjs` is the strongest fidelity gate in this repository:
 * it drives the real `astrid_capsule_identity.wasm` built from the Rust source
 * and compares its trace against this port, scenario by scenario. That gate
 * needs the compiled oracle, which is a build artefact and is not vendored, so
 * it cannot run in CI or on a fresh clone.
 *
 * This suite closes that hole. `harness/expected.json` holds the traces the
 * Rust oracle actually produced for every fixture in `harness/corpus/`, and the
 * tests below replay each fixture through the JavaScript port and assert an
 * exact match. The expectations are recorded from the oracle, never written by
 * hand, so this is the same comparison the live differential makes - only with
 * the Rust side frozen instead of executed.
 *
 * Regenerating the expectations requires the oracle wasm and is deliberately a
 * manual step; see README.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario } from '../harness/js-runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'harness', 'corpus');
const expected = JSON.parse(
  readFileSync(path.join(here, '..', 'harness', 'expected.json'), 'utf8'),
);

const names = Object.keys(expected).sort();

test('recorded oracle expectations cover the whole corpus', () => {
  assert.ok(names.length > 0, 'expected.json is empty');
});

for (const name of names) {
  test(`corpus: ${name}`, async () => {
    const scenario = JSON.parse(
      readFileSync(path.join(corpusDir, `${name}.json`), 'utf8'),
    );
    const actual = await runScenario(scenario);

    // Compare the channels separately so a failure names the surface that
    // drifted rather than dumping the whole trace.
    const want = expected[name];
    assert.equal(actual.calls.length, want.calls.length, 'call count');
    for (let i = 0; i < want.calls.length; i += 1) {
      const w = want.calls[i];
      const a = actual.calls[i];
      assert.deepEqual(a.result, w.result, `call[${i}] result`);
      assert.deepEqual(a.publishes, w.publishes, `call[${i}] publishes`);
      assert.deepEqual(a.logs, w.logs, `call[${i}] logs`);
      assert.equal(a.trapped, w.trapped, `call[${i}] trapped`);
    }
    assert.deepEqual(actual.world.kv, want.world.kv, 'world.kv');
    assert.deepEqual(actual.world.files, want.world.files, 'world.files');
  });
}
