/**
 * The ambient host boundary.
 *
 * Migration note: in the Rust capsule the host functions are WebAssembly
 * *imports* — `fs::read_to_string(path)` reaches the kernel with no handle
 * threaded through the call. Keeping the host ambient here lets `identity.js`
 * stay a line-for-line transcription of `src/lib.rs` instead of growing a
 * dependency-injection parameter on every method, which would obscure the
 * comparison with the source.
 *
 * A host implements the seven imports the capsule declares:
 *
 *   kvGet(key)            -> {ok: Uint8Array | null} | {err: {code, detail?}}
 *   kvSet(key, value)     -> {ok: null}              | {err: {code, detail?}}
 *   fsRead(path)          -> {ok: Uint8Array}        | {err: {code, detail?}}
 *   fsWrite(path, bytes)  -> {ok: null}              | {err: {code, detail?}}
 *   ipcPublish(topic, s)  -> {ok: null}              | {err: {code, detail?}}
 *   log(level, message)   -> void
 *   randomBytes(len)      -> {ok: Uint8Array}        | {err: {code, detail?}}
 */

/** @type {object|null} */
let current = null;

export function setHost(host) {
  current = host;
}

export function getHost() {
  if (current === null) {
    throw new Error('no astrid host is installed; call setHost() before invoking the capsule');
  }
  return current;
}

export function withHost(host, fn) {
  const previous = current;
  current = host;
  try {
    return fn();
  } finally {
    current = previous;
  }
}
