/**
 * `serde_json::Value` model and serializer.
 *
 * Migration note: JavaScript's `JSON.stringify` is *not* a drop-in for
 * `serde_json::to_string`. The two differ in object key ordering, which is
 * observable in every payload this capsule publishes:
 *
 *   - `serde_json::Map` is a `BTreeMap<String, Value>` (the `preserve_order`
 *     feature is not enabled anywhere in the dependency graph), so values built
 *     with the `json!` macro serialize with their keys in **sorted** order.
 *   - Rust structs deriving `Serialize` emit their fields in **declaration**
 *     order, regardless of the `Value` representation.
 *
 * `JSON.stringify` on a plain object emits insertion order (with integer-like
 * keys hoisted), which matches neither. So `json!`-shaped values go through
 * {@link JsonMap} (sorted on output) and struct-shaped values go through
 * {@link jsonStructString} (declaration order).
 */

import { compareUtf8, escapeDebugString } from './str.js';

/**
 * Rust's `f64` rendering as serde surfaces it in `invalid type:` messages.
 *
 * @param {number} x
 * @returns {string}
 */
export function f64Display(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sci = x.toExponential();
  const exp = Number(sci.slice(sci.indexOf('e') + 1));
  if (exp < -5 || exp > 15) return sci;
  const plain = String(x);
  return plain.includes('.') ? plain : `${plain}.0`;
}

/** `serde_json`'s `POW10` lookup table: the doubles for `1e0` .. `1e308`. */
const POW10 = [];
for (let i = 0; i <= 308; i += 1) POW10.push(Number(`1e${i}`));

const U64_MAX = 18446744073709551615n;
const I32_MAX = 2147483647;

/**
 * Rebuild a double the way `serde_json`'s `f64_from_parts` does.
 *
 * This deliberately does *not* use JavaScript's `Number(literal)`. `serde_json`
 * is built without its `float_roundtrip` feature, so it does not round
 * correctly: it accumulates a `u64` significand and then scales it by a single
 * `f64` power of ten. That multiplication carries rounding error, so `6e228`
 * becomes the double printed as `5.9999999999999995e+228` rather than the
 * nearest double to 6e228. Replaying the same arithmetic here reproduces the
 * identical bit pattern, because both languages use IEEE-754 doubles and
 * `Number('1e228')` is the same constant as Rust's `1e228`.
 *
 * @param {bigint} significand
 * @param {number} exponent
 * @param {boolean} positive
 * @returns {number | null} `null` signals `serde_json`'s `NumberOutOfRange`
 */
function f64FromParts(positive, significand, exponent) {
  let f = Number(significand);
  let exp = exponent;
  for (;;) {
    const index = Math.abs(exp);
    if (index < POW10.length) {
      if (exp >= 0) {
        f *= POW10[index];
        if (!Number.isFinite(f)) return null;
      } else {
        f /= POW10[index];
      }
      break;
    }
    if (f === 0) break;
    if (exp >= 0) return null;
    f /= 1e308;
    exp += 308;
  }
  return positive ? f : -f;
}

/**
 * Parse a JSON numeric literal into the double `serde_json` would produce.
 *
 * Mirrors `parse_integer` / `parse_long_integer` / `parse_decimal` /
 * `parse_exponent`: digits accumulate into a `u64` significand until the next
 * one would overflow, after which further *integer* digits are dropped but
 * still raise the exponent, and further *fraction* digits are dropped entirely.
 *
 * @param {string} raw
 * @returns {number | null} `null` signals `NumberOutOfRange`
 */
export function serdeParseF64(raw) {
  let i = 0;
  let positive = true;
  if (raw[i] === '-') {
    positive = false;
    i += 1;
  }

  let significand = 0n;
  let exponent = 0;
  let saturated = false;

  // Integer part: a digit the significand cannot hold is discarded, but it
  // still shifts the value, so it raises the exponent instead.
  while (i < raw.length && raw[i] >= '0' && raw[i] <= '9') {
    const digit = BigInt(raw.charCodeAt(i) - 48);
    if (saturated) {
      exponent += 1;
    } else {
      const next = significand * 10n + digit;
      if (next > U64_MAX) {
        saturated = true;
        exponent += 1;
      } else {
        significand = next;
      }
    }
    i += 1;
  }

  if (raw[i] === '.') {
    i += 1;
    while (i < raw.length && raw[i] >= '0' && raw[i] <= '9') {
      const digit = BigInt(raw.charCodeAt(i) - 48);
      if (!saturated) {
        const next = significand * 10n + digit;
        if (next > U64_MAX) {
          saturated = true;
        } else {
          significand = next;
          exponent -= 1;
        }
      }
      i += 1;
    }
  }

  if (raw[i] === 'e' || raw[i] === 'E') {
    i += 1;
    let sign = 1;
    if (raw[i] === '+') i += 1;
    else if (raw[i] === '-') {
      sign = -1;
      i += 1;
    }
    let value = 0;
    while (i < raw.length && raw[i] >= '0' && raw[i] <= '9') {
      if (value <= I32_MAX) value = value * 10 + (raw.charCodeAt(i) - 48);
      i += 1;
    }
    // `parse_exponent` folds the written exponent in with `saturating_add`.
    exponent = Math.max(-I32_MAX - 1, Math.min(I32_MAX, exponent + sign * Math.min(value, I32_MAX)));
  }

  return f64FromParts(positive, significand, exponent);
}

/**
 * A `serde_json` number.
 *
 * `serde_json` keeps integers and floats as distinct arms of `Number`, and the
 * distinction leaks into deserialization error messages
 * (``invalid type: integer `5` `` vs ``invalid type: floating point `1.5` ``),
 * so the parsed representation has to remember which one it saw. An integer
 * literal that fits neither `u64` nor `i64` is promoted to the float arm, which
 * is why `18446744073709551616` reports as `floating point`.
 */
export class JsonNumber {
  /**
   * @param {string} raw the literal text as it appeared in the document
   * @param {boolean} isFloat whether the literal had a fraction or exponent
   */
  constructor(raw, isFloat) {
    this.raw = raw;
    this.isFloat = isFloat;
  }

  /** How `serde_json` names this arm in `invalid type:` messages. */
  typeName() {
    return this.isF64() ? 'floating point' : 'integer';
  }

  /**
   * Whether `serde_json` parsed this literal into the `f64` arm.
   *
   * A literal with a fraction or exponent always is; a plain integer only
   * becomes one when it overflows `u64` (unsigned) or `i64` (negative).
   * `-0` is the remaining case: it has no signed-integer representation that
   * keeps the sign, so `serde_json` hands it to the float arm as `-0.0`.
   */
  isF64() {
    if (this.isFloat || this.raw === '-0') return true;
    const n = BigInt(this.raw);
    return n < -9223372036854775808n || n > 18446744073709551615n;
  }

  /**
   * Display form, matching Rust's `Display` for `u64`/`i64`/`f64`.
   *
   * The `f64` arm is `serde::de::Unexpected::Float`, which wraps ryu's
   * shortest-round-trip formatting in serde's `WithDecimalPoint`: decimal
   * notation whenever the decimal exponent is in `-5..=15` (with `.0` appended
   * if the digits alone carry no point), scientific `<mantissa>e<+|->_<exp>`
   * otherwise. JavaScript's own thresholds differ (`String` stays decimal up to
   * 1e21 and down to 1e-7), so the branch is selected explicitly.
   */
  display() {
    if (!this.isF64()) return this.raw;
    return f64Display(serdeParseF64(this.raw) ?? Number(this.raw));
  }

  /** Serialized form, which is the literal text `serde_json` re-emits. */
  serialize() {
    return this.display();
  }
}

/**
 * A `serde_json::Map<String, Value>`, i.e. a `BTreeMap`.
 *
 * Insertion order is preserved internally (needed to report `duplicate field`
 * at the right place and to iterate in document order the way `serde` does),
 * but {@link toJsonString} always emits keys in UTF-8 byte order to match
 * `BTreeMap` iteration.
 */
export class JsonMap {
  /** @param {Iterable<[string, unknown]>} [entries] */
  constructor(entries = []) {
    /** @type {Map<string, unknown>} */
    this.inner = new Map(entries);
  }

  get(key) {
    return this.inner.has(key) ? this.inner.get(key) : undefined;
  }

  has(key) {
    return this.inner.has(key);
  }

  set(key, value) {
    this.inner.set(key, value);
    return this;
  }

  get size() {
    return this.inner.size;
  }

  /** Entries in document (insertion) order — how `serde` visits a map. */
  entries() {
    return this.inner.entries();
  }

  /** Entries in `BTreeMap` order — how `serde_json` serializes a map. */
  sortedEntries() {
    return [...this.inner.entries()].sort((a, b) => compareUtf8(a[0], b[0]));
  }
}

/** Convenience constructor mirroring the `json!({ ... })` macro. */
export function jsonMap(obj) {
  return new JsonMap(Object.entries(obj));
}

/**
 * An already-serialized JSON fragment, spliced in verbatim.
 *
 * Lets a struct-shaped field (which must keep declaration order) nest inside
 * another struct without being flattened into a key-sorted {@link JsonMap}.
 */
export class RawJson {
  constructor(text) {
    this.text = text;
  }
}

export function rawJson(text) {
  return new RawJson(text);
}

/**
 * Escape a string exactly the way `serde_json` does.
 *
 * `serde_json` escapes `"`, `\`, and the C0 controls (using the short forms
 * `\b \t \n \f \r` where they exist and lowercase `\u00xx` otherwise). It does
 * not escape `/`, DEL, U+2028, U+2029, or any non-ASCII character. That is the
 * same set `JSON.stringify` produces, so delegating is correct here — the one
 * case where they could differ is a lone surrogate, which cannot occur in a
 * Rust `String` and is normalised by `JSON.stringify` into a `\udXXX` escape.
 */
export function escapeJsonString(s) {
  return JSON.stringify(s);
}

/**
 * Port of `serde_json::to_string` for a {@link JsonMap}-shaped `Value`.
 */
export function toJsonString(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof RawJson) return value.text;
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return escapeJsonString(value);
  if (value instanceof JsonNumber) return value.serialize();
  if (typeof value === 'number') return new JsonNumber(String(value), !Number.isInteger(value)).serialize();
  if (Array.isArray(value)) {
    return `[${value.map(toJsonString).join(',')}]`;
  }
  if (value instanceof JsonMap) {
    const parts = value.sortedEntries().map(([k, v]) => `${escapeJsonString(k)}:${toJsonString(v)}`);
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`not a serde_json::Value: ${Object.prototype.toString.call(value)}`);
}

/**
 * Serialize a struct-shaped value: an ordered list of `[key, value]` pairs
 * emitted in **declaration** order, the way `#[derive(Serialize)]` does.
 *
 * Used for `SparkConfig`, `IdentityBuilder`, and `BuildResponse`, whose field
 * order is part of the observable output (`__state` and
 * `spark.v1.response.ready` payloads).
 */
export function jsonStructString(fields) {
  const parts = fields.map(([k, v]) => `${escapeJsonString(k)}:${toJsonString(v)}`);
  return `{${parts.join(',')}}`;
}

/** `Value::as_str` — `Some(&str)` only for the string arm. */
export function asStr(value) {
  return typeof value === 'string' ? value : undefined;
}

/** `Value::get(key)` on an object, `None` for every other arm. */
export function valueGet(value, key) {
  return value instanceof JsonMap ? value.get(key) : undefined;
}

/**
 * `serde::de::Unexpected`'s `Display`, as rendered inside `invalid type:`.
 *
 * `serde_json` special-cases the unit arm — `de::Error::invalid_type` prints
 * `null` where plain `serde` would print `unit` — and renders string values
 * with Rust's `{:?}`, not with JSON escaping.
 */
export function serdeTypeName(value) {
  if (value === null) return 'null';
  if (value === true || value === false) return `boolean \`${value}\``;
  if (typeof value === 'string') return `string "${escapeDebugString(value)}"`;
  if (value instanceof JsonNumber) return `${value.typeName()} \`${value.display()}\``;
  if (Array.isArray(value)) return 'sequence';
  if (value instanceof JsonMap) return 'map';
  return 'unknown';
}
