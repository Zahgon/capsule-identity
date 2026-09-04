/**
 * Port of `astrid_sdk::prelude`, narrowed to the modules this capsule uses.
 *
 * The SDK exposes fs, net, process, env, time, log, runtime, ipc, kv, http,
 * uplink, elicit, identity, approval, capabilities, interceptors, types and
 * contracts; the identity capsule only ever touches `fs`, `kv`, `ipc` and
 * `log`, so only those four are ported. The rest are intentionally absent
 * rather than stubbed, so an accidental use fails loudly.
 */

import { SysError, hostErr } from './error.js';
import { getHost } from './host.js';
import { SerdeJsonError } from '../rust/json-parse.js';

// `ignoreBOM: true` KEEPS a leading U+FEFF rather than consuming it, matching
// `String::from_utf8`, which is byte-preserving. Stripping it here would hide
// the BOM from the TOML parser, which does its own (correct) BOM handling.
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();

function unwrap(result) {
  if (result.err !== undefined) throw hostErr(result.err);
  return result.ok;
}

/**
 * Normalise a host `list<u8>` to `Uint8Array`.
 *
 * The WIT host functions hand back a list of bytes; a JS host is free to
 * model that as a `Uint8Array`, a `Buffer` or a plain array of numbers.
 * Rust sees `Vec<u8>` either way, so the SDK boundary coerces once rather
 * than making every caller defensive.
 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value ?? []);
}

export const fs = {
  /** `astrid_sdk::fs::read`. */
  read(path) {
    return toBytes(unwrap(getHost().fsRead(path)));
  },

  /**
   * `astrid_sdk::fs::read_to_string`.
   *
   * Invalid UTF-8 becomes `SysError::ApiError` carrying `FromUtf8Error`'s
   * `Display`, which names the byte length and index of the bad sequence.
   */
  readToString(path) {
    const bytes = fs.read(path);
    try {
      return DECODER.decode(bytes);
    } catch {
      throw SysError.apiError(fromUtf8ErrorMessage(bytes));
    }
  },

  /** `astrid_sdk::fs::write`. */
  write(path, contents) {
    unwrap(getHost().fsWrite(path, contents));
  },
};

/**
 * Reproduce `std::string::FromUtf8Error`'s `Display`.
 *
 * Rust reports the *first* invalid sequence as
 * `invalid utf-8 sequence of N bytes from index I`, or, when the input simply
 * ends mid-character, `incomplete utf-8 byte sequence from index I`. The
 * validation below is `core::str::from_utf8`'s state machine, restricted to
 * finding that first failure.
 */
function fromUtf8ErrorMessage(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let width;
    if (b >= 0xc2 && b <= 0xdf) width = 2;
    else if (b >= 0xe0 && b <= 0xef) width = 3;
    else if (b >= 0xf0 && b <= 0xf4) width = 4;
    else return `invalid utf-8 sequence of 1 bytes from index ${i}`;

    let valid = 1;
    for (let k = 1; k < width; k += 1) {
      const c = bytes[i + k];
      if (c === undefined) return `incomplete utf-8 byte sequence from index ${i}`;
      const lowerBound = k === 1 && b === 0xe0 ? 0xa0 : k === 1 && b === 0xf0 ? 0x90 : 0x80;
      const upperBound = k === 1 && b === 0xed ? 0x9f : k === 1 && b === 0xf4 ? 0x8f : 0xbf;
      if (c < lowerBound || c > upperBound) {
        return `invalid utf-8 sequence of ${valid} bytes from index ${i}`;
      }
      valid += 1;
    }
    i += width;
  }
  return 'invalid utf-8 sequence of 1 bytes from index 0';
}

export const kv = {
  /** `astrid_sdk::kv::get_bytes` — a missing key reads back as empty. */
  getBytes(key) {
    const value = unwrap(getHost().kvGet(key));
    return value === null || value === undefined ? new Uint8Array(0) : toBytes(value);
  },

  /**
   * `astrid_sdk::kv::get_json`.
   *
   * A missing key yields zero bytes, which `serde_json::from_slice` rejects
   * with `EOF while parsing a value` — a `SysError::JsonError`. The capsule
   * macro relies on exactly that to fall back to `Default::default()`, so this
   * must not be "helpfully" turned into a `None`.
   */
  getJson(key, deserialize) {
    const bytes = kv.getBytes(key);
    try {
      return deserialize(bytes);
    } catch (err) {
      if (err instanceof SerdeJsonError) throw SysError.jsonError(err);
      throw err;
    }
  },

  /** `astrid_sdk::kv::set_bytes`. */
  setBytes(key, value) {
    unwrap(getHost().kvSet(key, value));
  },

  /** `astrid_sdk::kv::set_json`. */
  setJson(key, serialized) {
    kv.setBytes(key, ENCODER.encode(serialized));
  },
};

export const ipc = {
  /** `astrid_sdk::ipc::publish`. */
  publish(topic, payload) {
    unwrap(getHost().ipcPublish(topic, payload));
  },

  /**
   * `astrid_sdk::ipc::publish_json`.
   *
   * The payload is serialized by the caller so that struct-shaped and
   * `json!`-shaped values keep their respective key orders.
   */
  publishJson(topic, serialized) {
    ipc.publish(topic, serialized);
  },
};

export const LogLevel = Object.freeze({
  Trace: 0,
  Debug: 1,
  Info: 2,
  Warn: 3,
  Error: 4,
});

export const log = {
  trace: (message) => getHost().log(LogLevel.Trace, String(message)),
  debug: (message) => getHost().log(LogLevel.Debug, String(message)),
  info: (message) => getHost().log(LogLevel.Info, String(message)),
  warn: (message) => getHost().log(LogLevel.Warn, String(message)),
  error: (message) => getHost().log(LogLevel.Error, String(message)),
};

/**
 * Port of `astrid_sdk::install_panic_handler`.
 *
 * The Rust hook is guarded by a `std::sync::Once`, so it installs at most once
 * per instance; the flag below reproduces that. A panic is logged at `error`
 * level as `capsule panic at {file}:{line}:{col}: {payload}`.
 */
let panicHandlerInstalled = false;

export function installPanicHandler() {
  panicHandlerInstalled = true;
}

export function panicHandlerActive() {
  return panicHandlerInstalled;
}

export { SysError, hostErr };
export { setHost, getHost, withHost } from './host.js';
