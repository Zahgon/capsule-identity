/**
 * Direct unit tests for the emulation layer.
 *
 * The corpus suite drives everything through `astrid-hook-trigger`, which is
 * how the kernel reaches this capsule, so it only covers what a hook can
 * reach. A handful of ported helpers sit outside that path: `serde_json`
 * surface the capsule's own types never use, the `random-bytes` host call the
 * Rust crate imports but never invokes, and the log levels other than `warn`.
 * They are still part of the ported surface, so they are pinned here directly.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonMap, JsonNumber, jsonMap, toJsonString } from '../src/rust/json-value.js';
import { ErrorCode, SerdeJsonError } from '../src/rust/json-parse.js';
import { buildRequestFromSlice } from '../src/rust/serde.js';
import { sparkConfigFromToml } from '../src/rust/toml/index.js';
import { getHost, setHost, withHost } from '../src/sdk/host.js';
import { LogLevel, installPanicHandler, log, panicHandlerActive } from '../src/sdk/index.js';
import { createLocalHost } from '../src/sdk/local-host.js';
import { debugName } from '../harness/world.mjs';
import { hostForWorld } from '../harness/js-runner.mjs';
import { createWorld } from '../harness/world.mjs';

const encode = (text) => new TextEncoder().encode(text);

test('JsonMap models a serde_json::Map', () => {
  const map = jsonMap({ zeta: 'z', alpha: 'a' });

  assert.equal(map.has('alpha'), true);
  assert.equal(map.has('missing'), false);
  assert.equal(map.size, 2);
  assert.equal(map.get('zeta'), 'z');
  assert.equal(map.get('missing'), undefined);

  // `entries` is insertion order, the order `serde` visits a map in; only
  // `sortedEntries` is the `BTreeMap` order `serde_json` serializes in.
  assert.deepEqual(
    Array.from(map.entries(), ([key]) => key),
    ['zeta', 'alpha'],
  );
  assert.deepEqual(
    Array.from(map.sortedEntries(), ([key]) => key),
    ['alpha', 'zeta'],
  );
  assert.equal(toJsonString(map), '{"alpha":"a","zeta":"z"}');

  const built = new JsonMap();
  assert.equal(built.set('k', 1), built, 'set is chainable');
  assert.equal(built.size, 1);
});

test('JsonNumber re-emits the literal serde_json would write', () => {
  assert.equal(new JsonNumber('42', false).serialize(), '42');
  assert.equal(new JsonNumber('3.5', true).serialize(), '3.5');
  assert.equal(new JsonNumber('100.0', true).serialize(), '100.0');
  assert.equal(new JsonNumber('1e16', true).serialize(), '1e+16');
  assert.equal(new JsonNumber('-0', false).serialize(), '-0.0');
});

test('a positionless serde error adopts the first position it passes', () => {
  const positionless = new SerdeJsonError(ErrorCode.ExpectedSomeValue, 0, 0);
  assert.equal(positionless.display(), ErrorCode.ExpectedSomeValue);

  const positioned = positionless.withPosition(1, 7);
  assert.equal(positioned.display(), `${ErrorCode.ExpectedSomeValue} at line 1 column 7`);

  // Already-positioned errors keep their original position, exactly as
  // `serde_json::Error::fix_position` does.
  assert.equal(positioned.withPosition(9, 9), positioned);
});

test('a truncated top-level container still reports a serde error', () => {
  // Both of these abort inside the top-level container parser, which is the
  // only path that records a partial node so a later field error can win.
  assert.throws(() => buildRequestFromSlice(encode('{"workspace_root":"/ws"')));
  assert.throws(() => buildRequestFromSlice(encode('["/ws"')));
});

test('multiline literal strings parse', () => {
  assert.equal(sparkConfigFromToml("callsign = '''Lyra'''\n").callsign, 'Lyra');
  // A newline immediately after the opening delimiter is trimmed.
  assert.equal(sparkConfigFromToml("callsign = '''\nLyra'''\n").callsign, 'Lyra');
  assert.equal(sparkConfigFromToml("callsign = '''a\\b'''\n").callsign, 'a\\b');
});

test('setHost installs a host for the rest of the process', () => {
  const previous = (() => {
    try {
      return getHost();
    } catch {
      return null;
    }
  })();
  const calls = [];
  const stub = { log: (level, message) => calls.push([level, message]) };

  setHost(stub);
  try {
    assert.equal(getHost(), stub);

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    assert.deepEqual(calls, [
      [LogLevel.Trace, 't'],
      [LogLevel.Debug, 'd'],
      [LogLevel.Info, 'i'],
      [LogLevel.Warn, 'w'],
      [LogLevel.Error, 'e'],
    ]);
  } finally {
    setHost(previous);
  }
});

test('the panic handler records that it was installed', () => {
  installPanicHandler();
  assert.equal(panicHandlerActive(), true);
  // The Rust hook is guarded by a `Once`, so installing twice is a no-op.
  installPanicHandler();
  assert.equal(panicHandlerActive(), true);
});

test('the local host logs, writes and fills random bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-emul-'));
  const host = createLocalHost({ root, statePath: join(root, '.kv.json') });

  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    host.log(LogLevel.Warn, 'careful');
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(written, ['[WARN] careful\n']);

  const random = host.randomBytes(4);
  assert.equal(random.ok.length, 4);

  assert.deepEqual(host.fsWrite('home://note.txt', encode('hi')), { ok: undefined });
  assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'hi');
});

test('the harness host serves deterministic random bytes', () => {
  // The capsule never calls `random-bytes`, but the Rust crate imports it, so
  // the harness has to answer it for the wasm and the port identically.
  const world = createWorld({ randomByte: 7 });
  assert.deepEqual(hostForWorld(world).randomBytes(3), { ok: [7, 7, 7] });
});

test('WIT error codes render the way Rust derives Debug', () => {
  assert.equal(debugName('capability-denied'), 'CapabilityDenied');
  assert.equal(debugName('not-found'), 'NotFound');
  assert.equal(debugName('quota'), 'Quota');
});

test('withHost restores the previous host', () => {
  const stub = { log: () => {} };
  setHost(stub);
  try {
    withHost({ log: () => {} }, () => {});
    assert.equal(getHost(), stub);
  } finally {
    setHost(null);
  }
});
