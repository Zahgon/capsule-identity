// Drives the migrated JavaScript capsule through `astridHookTrigger`,
// producing a trace in exactly the shape `oracle.mjs` produces for the
// compiled Rust capsule.
//
// The two runners share `world.mjs`, so the KV store, the virtual
// filesystem, the injected host errors, the publish log and the log
// records are literally the same implementation. Any difference in the
// resulting trace is therefore attributable to the capsule code alone.

import fs from 'node:fs';

import { createWorld, snapshot, LOG_LEVELS } from './world.mjs';
import { astridHookTrigger } from '../src/capsule.js';
import { withHost } from '../src/sdk/host.js';

/**
 * Adapt the shared scenario world to the host interface `src/sdk` calls.
 *
 * `world.mjs` models the raw WIT imports (which is what the wasm oracle
 * needs); the JS SDK expects the same seven functions with JS-native
 * argument types. The error-injection rules are applied identically:
 * an `fsErrors` entry with `op: 'read'` short-circuits `fsRead`, an
 * `ipcErrors` entry still records the publish attempt before failing,
 * and a missing file yields `not-found` exactly as the kernel would.
 *
 * @param {ReturnType<typeof createWorld>} world
 */
export function hostForWorld(world) {
  return {
    kvGet(key) {
      const injected = world.kvErrors[key];
      if (injected && (injected.op ?? 'get') === 'get') return { err: injected };
      const value = world.kv.get(key);
      return { ok: value === undefined ? null : Array.from(value) };
    },
    kvSet(key, value) {
      const injected = world.kvErrors[key];
      if (injected && injected.op === 'set') return { err: injected };
      world.kv.set(key, Buffer.from(Uint8Array.from(value)));
      return { ok: undefined };
    },
    fsRead(path) {
      const injected = world.fsErrors[path];
      if (injected && (injected.op ?? 'read') === 'read') return { err: injected };
      const file = world.files.get(path);
      if (file === undefined) return { err: { code: 'not-found' } };
      return { ok: Array.from(file) };
    },
    fsWrite(path, bytes) {
      const injected = world.fsErrors[path];
      if (injected && injected.op === 'write') return { err: injected };
      world.files.set(path, Buffer.from(Uint8Array.from(bytes)));
      return { ok: undefined };
    },
    ipcPublish(topic, payload) {
      const injected = world.ipcErrors[topic];
      if (injected) {
        world.publishes.push({ topic, payload, failed: true });
        return { err: typeof injected === 'string' ? { code: injected } : injected };
      }
      world.publishes.push({ topic, payload });
      return { ok: undefined };
    },
    log(level, message) {
      world.logs.push({ level: LOG_LEVELS[level] ?? `?${level}`, message });
    },
    randomBytes(length) {
      return { ok: Array.from(Buffer.alloc(Number(length), world.randomByte)) };
    },
  };
}

/**
 * @param {object} scenario same schema `oracle.mjs` consumes
 * @returns {Promise<object>} trace with `calls` and `world`
 */
export async function runScenario(scenario) {
  const world = createWorld(scenario);
  const host = hostForWorld(world);
  const results = [];

  for (const call of scenario.calls ?? []) {
    const payload = call.payloadB64 !== undefined
      ? Buffer.from(call.payloadB64, 'base64')
      : Buffer.from(call.payload ?? '', 'utf8');

    const logsBefore = world.logs.length;
    const pubsBefore = world.publishes.length;

    let out;
    try {
      out = withHost(host, () => astridHookTrigger(call.action, new Uint8Array(payload)));
    } catch (err) {
      // The Rust build compiles with `panic = "abort"`, so an unexpected
      // panic surfaces to the runner as a wasm trap. Report an uncaught
      // JavaScript exception the same way so the differ can compare it.
      results.push({ action: call.action, trapped: String(err && err.message) });
      continue;
    }

    results.push({
      action: call.action,
      result: { action: out.action, data: out.data ?? null },
      publishes: world.publishes.slice(pubsBefore),
      logs: world.logs.slice(logsBefore),
    });
  }

  return { calls: results, world: snapshot(world) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(await runScenario(scenario), null, 2));
}
