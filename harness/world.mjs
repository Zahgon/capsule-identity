// Canonical-ABI host shim for the Astrid capsule core module.
//
// Implements the 7 WIT host imports the capsule links against:
//   astrid:kv/host@1.0.0    kv-get, kv-set
//   astrid:fs/host@1.0.0    read-file, write-file
//   astrid:ipc/host@1.0.0   publish
//   astrid:sys/host@1.0.0   log, random-bytes
//
// The host is deliberately NOT part of the migration surface: the exact
// same host semantics are presented to the Rust oracle and to the JS
// port, so any trace difference is attributable to the capsule itself.

export const FS_ERR = [
  'not-found', 'access', 'capability-denied', 'boundary-escape', 'invalid-path',
  'would-block', 'is-directory', 'not-directory', 'not-empty', 'too-large',
  'quota', 'cross-vfs', 'already-exists', 'closed', 'unknown',
];
export const KV_ERR = ['invalid-key', 'too-large', 'quota', 'cas-mismatch', 'unknown'];
export const IPC_ERR = [
  'capability-denied', 'invalid-input', 'closed', 'rate-limited',
  'backpressure', 'quota', 'timeout', 'unknown',
];
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

// Rust's `#[derive(Debug)]` on the wit-bindgen enums renders variants in
// UpperCamelCase; `host_err` formats them with `{:?}`, and that string is
// what surfaces in SysError::HostError("Host function call failed: {0}").
export function debugName(kebab) {
  return kebab.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('');
}

/**
 * Build the in-memory world a single scenario runs against.
 * `kv` and `fs` are plain objects keyed by string; values are UTF-8 strings
 * unless supplied through the `*B64` maps.
 */
export function createWorld(scenario = {}) {
  const kv = new Map();
  for (const [k, v] of Object.entries(scenario.kv ?? {})) kv.set(k, Buffer.from(v, 'utf8'));
  for (const [k, v] of Object.entries(scenario.kvB64 ?? {})) kv.set(k, Buffer.from(v, 'base64'));

  const files = new Map();
  for (const [k, v] of Object.entries(scenario.fs ?? {})) files.set(k, Buffer.from(v, 'utf8'));
  for (const [k, v] of Object.entries(scenario.fsB64 ?? {})) files.set(k, Buffer.from(v, 'base64'));

  return {
    kv,
    files,
    kvErrors: scenario.kvErrors ?? {},   // { key: { op: 'get'|'set', code, detail? } }
    fsErrors: scenario.fsErrors ?? {},   // { path: { op: 'read'|'write', code, detail? } }
    ipcErrors: scenario.ipcErrors ?? {}, // { topic: code | { code, detail? } }
    publishes: [],
    logs: [],
    randomByte: scenario.randomByte ?? 0,
  };
}

/** Snapshot the mutable world in a stable, diffable form. */
export function snapshot(world) {
  const dump = (m) => {
    const out = {};
    for (const k of [...m.keys()].sort()) {
      const buf = m.get(k);
      const text = buf.toString('utf8');
      // Round-trip check: only emit as text when it is faithfully UTF-8.
      out[k] = Buffer.compare(Buffer.from(text, 'utf8'), buf) === 0
        ? { text }
        : { b64: buf.toString('base64') };
    }
    return out;
  };
  return { kv: dump(world.kv), files: dump(world.files) };
}
