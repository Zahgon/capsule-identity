// Reference host implementation backed by the real filesystem.
//
// Migration note: the Rust crate has NO equivalent of this file. It is
// compiled to a wasm component whose seven host imports
// (`astrid:kv/host`, `astrid:fs/host`, `astrid:ipc/host`,
// `astrid:sys/host`) are supplied by the Astrid kernel at instantiation
// time. A Node process has no component-model host, so running the
// capsule outside the kernel requires supplying those imports directly.
//
// This host exists purely so the capsule can be started and exercised
// standalone (`bin/capsule.js`). It is NOT part of the capsule's
// observable surface: every behavioural check in `test/` and
// `harness/` uses the in-memory host so results stay deterministic.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { randomFillSync } from 'node:crypto';

const HOME_SCHEME = 'home://';

/**
 * Translate a capsule VFS path into a real filesystem path.
 *
 * Mirrors the kernel's `home://` mount plus its boundary check: a path
 * that escapes the mount root is rejected with `boundary-escape`, and a
 * path with no recognised scheme is rejected with `invalid-path`. Those
 * are the same `astrid:fs/host` error codes the kernel would return, so
 * the capsule's error strings stay identical.
 *
 * @param {string} root absolute path of the `home://` mount
 * @param {string} path capsule-visible path
 * @returns {{ok: string} | {err: {code: string, detail?: string}}}
 */
function resolveVfsPath(root, path) {
  if (!path.startsWith(HOME_SCHEME)) {
    return { err: { code: 'invalid-path' } };
  }
  const relative = path.slice(HOME_SCHEME.length);
  if (relative.startsWith('/')) {
    return { err: { code: 'invalid-path' } };
  }
  const target = resolve(join(root, normalize(relative)));
  if (target !== root && !target.startsWith(root + sep)) {
    return { err: { code: 'boundary-escape' } };
  }
  return { ok: target };
}

/**
 * Map a Node `fs` errno onto the `astrid:fs/host` error-code variant the
 * kernel would report, so `SysError` text matches the Rust build.
 *
 * @param {NodeJS.ErrnoException} error
 * @returns {{code: string, detail?: string}}
 */
function fsErrorCode(error) {
  switch (error.code) {
    case 'ENOENT':
      return { code: 'not-found' };
    case 'EACCES':
    case 'EPERM':
      return { code: 'access' };
    case 'EISDIR':
      return { code: 'is-directory' };
    case 'ENOTDIR':
      return { code: 'not-directory' };
    case 'ENOTEMPTY':
      return { code: 'not-empty' };
    case 'EEXIST':
      return { code: 'already-exists' };
    case 'EFBIG':
      return { code: 'too-large' };
    case 'EDQUOT':
    case 'ENOSPC':
      return { code: 'quota' };
    case 'EAGAIN':
      return { code: 'would-block' };
    default:
      return { code: 'unknown', detail: String(error.message ?? error) };
  }
}

const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * Build a host that persists KV state in a JSON file, serves the
 * `home://` scheme from `root`, writes IPC publishes and log records to
 * the supplied sinks.
 *
 * @param {object} options
 * @param {string} options.root directory backing `home://`
 * @param {string} options.statePath JSON file backing the KV store
 * @param {(topic: string, payload: string) => void} [options.onPublish]
 * @param {(level: number, message: string) => void} [options.onLog]
 * @returns {import('./host.js').CapsuleHost}
 */
export function createLocalHost({ root, statePath, onPublish, onLog }) {
  const mountRoot = resolve(root);
  /** @type {Map<string, string>} base64-encoded values, mirroring `list<u8>` */
  const store = new Map();

  try {
    const raw = readFileSync(statePath, 'utf8');
    for (const [key, value] of Object.entries(JSON.parse(raw))) {
      store.set(key, value);
    }
  } catch {
    // Absent or unreadable state file == empty KV namespace, which is
    // exactly what a freshly installed capsule sees.
  }

  const flush = () => {
    const out = {};
    for (const [key, value] of store) out[key] = value;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(out));
  };

  const publish = onPublish ?? ((topic, payload) => process.stdout.write(`${topic}\t${payload}\n`));
  const record = onLog ?? ((level, message) => process.stderr.write(`[${LEVEL_NAMES[level]}] ${message}\n`));

  return {
    kvGet(key) {
      const value = store.get(key);
      return { ok: value === undefined ? null : Array.from(Buffer.from(value, 'base64')) };
    },
    kvSet(key, value) {
      store.set(key, Buffer.from(Uint8Array.from(value)).toString('base64'));
      flush();
      return { ok: undefined };
    },
    fsRead(path) {
      const resolved = resolveVfsPath(mountRoot, path);
      if ('err' in resolved) return resolved;
      try {
        return { ok: Array.from(readFileSync(resolved.ok)) };
      } catch (error) {
        return { err: fsErrorCode(/** @type {NodeJS.ErrnoException} */ (error)) };
      }
    },
    fsWrite(path, bytes) {
      const resolved = resolveVfsPath(mountRoot, path);
      if ('err' in resolved) return resolved;
      try {
        mkdirSync(dirname(resolved.ok), { recursive: true });
        writeFileSync(resolved.ok, Buffer.from(Uint8Array.from(bytes)));
        return { ok: undefined };
      } catch (error) {
        return { err: fsErrorCode(/** @type {NodeJS.ErrnoException} */ (error)) };
      }
    },
    ipcPublish(topic, payload) {
      publish(topic, payload);
      return { ok: undefined };
    },
    log(level, message) {
      record(level, message);
    },
    randomBytes(length) {
      const buffer = Buffer.alloc(Number(length));
      randomFillSync(buffer);
      return { ok: Array.from(buffer) };
    },
  };
}
