/**
 * A `serde_json`-compatible JSON reader.
 *
 * Migration note: `JSON.parse` cannot be used here. Every JSON decode failure in
 * this capsule is surfaced to the caller verbatim — as the `data` of a `deny`
 * result, as the `content` of a tool-call result, or as a `log::warn` line — so
 * the *text* of the failure is part of the observable contract:
 *
 *     failed to parse arguments: invalid type: integer `5`, expected a string at line 1 column 19
 *
 * `JSON.parse` produces engine-specific prose with no stable positions, so this
 * module reproduces `serde_json`'s error codes and its `line`/`column`
 * accounting instead.
 *
 * Parsing produces a *node* tree rather than a bare value: `serde` is a pull
 * parser, so it reports a type error at the byte offset just past the offending
 * token. Recording each node's end offset lets the typed deserializers in
 * `serde.js` reproduce those positions without a second parsing pass.
 */

import { JsonMap, JsonNumber, serdeParseF64 } from './json-value.js';

/** `serde_json::error::ErrorCode`, rendered exactly as its `Display` impl. */
export const ErrorCode = {
  EofWhileParsingValue: 'EOF while parsing a value',
  EofWhileParsingList: 'EOF while parsing a list',
  EofWhileParsingObject: 'EOF while parsing an object',
  EofWhileParsingString: 'EOF while parsing a string',
  ExpectedColon: 'expected `:`',
  ExpectedListCommaOrEnd: 'expected `,` or `]`',
  ExpectedObjectCommaOrEnd: 'expected `,` or `}`',
  ExpectedSomeIdent: 'expected ident',
  ExpectedSomeValue: 'expected value',
  InvalidEscape: 'invalid escape',
  InvalidNumber: 'invalid number',
  NumberOutOfRange: 'number out of range',
  InvalidUnicodeCodePoint: 'invalid unicode code point',
  ControlCharacterWhileParsingString:
    'control character (\\u0000-\\u001F) found while parsing a string',
  KeyMustBeAString: 'key must be a string',
  LoneLeadingSurrogateInHexEscape: 'lone leading surrogate in hex escape',
  TrailingCharacters: 'trailing characters',
  TrailingComma: 'trailing comma',
  UnexpectedEndOfHexEscape: 'unexpected end of hex escape',
};

/**
 * Port of `serde_json::Error`.
 *
 * `line === 0` marks a positionless error, which is what
 * `serde_json::from_value` produces; `Display` then omits the ` at line …`
 * suffix, exactly as the Rust impl does.
 */
export class SerdeJsonError extends Error {
  /**
   * @param {string} code rendered error code
   * @param {number} line 1-based line, or 0 for "no position"
   * @param {number} column 0-based column, as `serde_json` computes it
   */
  constructor(code, line = 0, column = 0) {
    super(line === 0 ? code : `${code} at line ${line} column ${column}`);
    this.name = 'SerdeJsonError';
    this.code = code;
    this.line = line;
    this.column = column;
  }

  /** `impl Display for serde_json::Error`. */
  display() {
    return this.line === 0
      ? this.code
      : `${this.code} at line ${this.line} column ${this.column}`;
  }

  /**
   * Port of `Error::fix_position`: a positionless error picks up the reader's
   * current position the first time it passes through a positioned frame.
   */
  withPosition(line, column) {
    return this.line === 0 ? new SerdeJsonError(this.code, line, column) : this;
  }
}

// `ignoreBOM: true` inverts its name: it KEEPS a leading U+FEFF instead of
// consuming it. Rust's `str::from_utf8` never strips a BOM, and U+FEFF is not
// `str::trim` whitespace, so `{"text":"\uFEFFidentity-export"}` must not match.
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Byte-oriented reader mirroring `serde_json::read::SliceRead`. */
class SliceRead {
  /** @param {Uint8Array} slice */
  constructor(slice) {
    this.slice = slice;
    this.index = 0;
  }

  /** `SliceRead::position_of_index` — line is 1-based, column is 0-based. */
  positionOfIndex(i) {
    let startOfLine = 0;
    for (let k = Math.min(i, this.slice.length) - 1; k >= 0; k -= 1) {
      if (this.slice[k] === 0x0a) {
        startOfLine = k + 1;
        break;
      }
    }
    let line = 1;
    for (let k = 0; k < startOfLine; k += 1) {
      if (this.slice[k] === 0x0a) line += 1;
    }
    return { line, column: i - startOfLine };
  }

  position() {
    return this.positionOfIndex(this.index);
  }

  peekPosition() {
    return this.positionOfIndex(this.index + 1);
  }

  error(code) {
    const { line, column } = this.position();
    return new SerdeJsonError(code, line, column);
  }

  peekError(code) {
    const { line, column } = this.peekPosition();
    return new SerdeJsonError(code, line, column);
  }

  peek() {
    return this.index < this.slice.length ? this.slice[this.index] : null;
  }

  next() {
    return this.index < this.slice.length ? this.slice[this.index++] : null;
  }

  discard() {
    this.index += 1;
  }
}

function isWhitespaceByte(b) {
  // `serde_json` accepts exactly these four as insignificant whitespace.
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function skipWhitespace(read) {
  while (true) {
    const b = read.peek();
    if (b !== null && isWhitespaceByte(b)) read.discard();
    else return b;
  }
}

function parseIdent(read, ident, code) {
  for (let i = 0; i < ident.length; i += 1) {
    const b = read.next();
    if (b === null) throw read.error(ErrorCode.EofWhileParsingValue);
    if (b !== ident.charCodeAt(i)) throw read.error(code);
  }
}

const HEX = (b) => {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return -1;
};

function decodeHexEscape(read) {
  let n = 0;
  for (let i = 0; i < 4; i += 1) {
    const b = read.next();
    if (b === null) throw read.error(ErrorCode.EofWhileParsingString);
    const v = HEX(b);
    if (v < 0) throw read.error(ErrorCode.InvalidEscape);
    n = (n << 4) | v;
  }
  return n;
}

/** Parse a string body, `read.index` already past the opening quote. */
function parseStringBody(read) {
  /** @type {number[]} */
  const raw = [];
  while (true) {
    const b = read.next();
    if (b === null) throw read.error(ErrorCode.EofWhileParsingString);
    if (b === 0x22) break; // closing quote
    if (b === 0x5c) {
      const esc = read.next();
      if (esc === null) throw read.error(ErrorCode.EofWhileParsingString);
      switch (esc) {
        case 0x22: raw.push(0x22); break;
        case 0x5c: raw.push(0x5c); break;
        case 0x2f: raw.push(0x2f); break;
        case 0x62: raw.push(0x08); break;
        case 0x66: raw.push(0x0c); break;
        case 0x6e: raw.push(0x0a); break;
        case 0x72: raw.push(0x0d); break;
        case 0x74: raw.push(0x09); break;
        case 0x75: {
          const n1 = decodeHexEscape(read);
          let cp;
          if (n1 >= 0xdc00 && n1 <= 0xdfff) {
            throw read.error(ErrorCode.LoneLeadingSurrogateInHexEscape);
          } else if (n1 >= 0xd800 && n1 <= 0xdbff) {
            // A leading surrogate must be followed by `\uXXXX` forming a pair.
            if (read.peek() !== 0x5c) {
              read.discard();
              throw read.error(ErrorCode.UnexpectedEndOfHexEscape);
            }
            read.discard();
            if (read.peek() !== 0x75) {
              read.discard();
              throw read.error(ErrorCode.UnexpectedEndOfHexEscape);
            }
            read.discard();
            const n2 = decodeHexEscape(read);
            if (n2 < 0xdc00 || n2 > 0xdfff) {
              throw read.error(ErrorCode.LoneLeadingSurrogateInHexEscape);
            }
            cp = 0x10000 + (((n1 - 0xd800) << 10) | (n2 - 0xdc00));
          } else {
            cp = n1;
          }
          pushUtf8(raw, cp);
          break;
        }
        default:
          throw read.error(ErrorCode.InvalidEscape);
      }
      continue;
    }
    if (b < 0x20) throw read.error(ErrorCode.ControlCharacterWhileParsingString);
    raw.push(b);
  }
  try {
    return TEXT_DECODER.decode(Uint8Array.from(raw));
  } catch {
    throw read.error(ErrorCode.InvalidUnicodeCodePoint);
  }
}

function pushUtf8(out, cp) {
  if (cp < 0x80) out.push(cp);
  else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

function parseNumber(read) {
  const start = read.index;
  if (read.peek() === 0x2d) read.discard();
  // `parse_integer` pulls the next byte with `next_char()` before classifying it,
  // so end-of-input is an EOF error while a wrong byte is reported one past itself.
  const first = read.peek();
  if (first === null) throw read.error(ErrorCode.EofWhileParsingValue);
  if (first < 0x30 || first > 0x39) {
    read.discard();
    throw read.error(ErrorCode.InvalidNumber);
  }
  while (read.peek() !== null && read.peek() >= 0x30 && read.peek() <= 0x39) {
    read.discard();
  }
  let isFloat = false;
  if (read.peek() === 0x2e) {
    isFloat = true;
    read.discard();
    let frac = 0;
    while (read.peek() !== null && read.peek() >= 0x30 && read.peek() <= 0x39) {
      read.discard();
      frac += 1;
    }
    if (frac === 0) throw read.error(ErrorCode.InvalidNumber);
  }
  const e = read.peek();
  if (e === 0x65 || e === 0x45) {
    isFloat = true;
    read.discard();
    const sign = read.peek();
    if (sign === 0x2b || sign === 0x2d) read.discard();
    let exp = 0;
    while (read.peek() !== null && read.peek() >= 0x30 && read.peek() <= 0x39) {
      read.discard();
      exp += 1;
    }
    if (exp === 0) throw read.error(ErrorCode.InvalidNumber);
  }
  const raw = String.fromCharCode(...read.slice.subarray(start, read.index));
  // A literal whose magnitude overflows `f64` is rejected while it is being
  // read, not when a visitor later objects to its type.
  const number = new JsonNumber(raw, isFloat);
  if (number.isF64() && serdeParseF64(raw) === null) throw read.error(ErrorCode.NumberOutOfRange);
  return number;
}

function parseValueNode(read, isTop = false) {
  const b = skipWhitespace(read);
  if (b === null) throw read.error(ErrorCode.EofWhileParsingValue);
  const start = read.index;
  switch (b) {
    case 0x6e: // n
      read.discard();
      parseIdent(read, 'ull', ErrorCode.ExpectedSomeIdent);
      return { kind: 'null', start, end: read.index };
    case 0x74: // t
      read.discard();
      parseIdent(read, 'rue', ErrorCode.ExpectedSomeIdent);
      return { kind: 'bool', value: true, start, end: read.index };
    case 0x66: // f
      read.discard();
      parseIdent(read, 'alse', ErrorCode.ExpectedSomeIdent);
      return { kind: 'bool', value: false, start, end: read.index };
    case 0x22: {
      read.discard();
      const value = parseStringBody(read);
      return { kind: 'string', value, start, end: read.index };
    }
    case 0x5b:
      return parseArrayNode(read, isTop);
    case 0x7b:
      return parseObjectNode(read, isTop);
    default: {
      if (b === 0x2d || (b >= 0x30 && b <= 0x39)) {
        const value = parseNumber(read);
        return { kind: 'number', value, start, end: read.index };
      }
      throw read.peekError(ErrorCode.ExpectedSomeValue);
    }
  }
}

function parseArrayNode(read, isTop = false) {
  // `serde_json::peek_invalid_type` reports a mistyped `[`/`{` at the *opening*
  // bracket because that arm never calls `eat_char()`, unlike every scalar arm.
  const start = read.index;
  read.discard(); // `[`
  const items = [];
  const fail = (err) => {
    // `serde` is a pull parser: a struct visitor consumes elements one at a
    // time, so a *semantic* error on an early element is reported before the
    // parser ever reaches a later syntax error. Handing the partially parsed
    // prefix back lets the typed deserializers reproduce that ordering.
    if (isTop) err.partialNode = { kind: 'array', start, items, incomplete: true, end: read.index };
    return err;
  };
  let b = skipWhitespace(read);
  if (b === null) throw fail(read.error(ErrorCode.EofWhileParsingList));
  if (b === 0x5d) {
    read.discard();
    return { kind: 'array', start, items, end: read.index };
  }
  while (true) {
    try {
      items.push(parseValueNode(read));
    } catch (err) {
      throw fail(err);
    }
    b = skipWhitespace(read);
    if (b === null) throw fail(read.error(ErrorCode.EofWhileParsingList));
    if (b === 0x2c) {
      read.discard();
      const nb = skipWhitespace(read);
      if (nb === 0x5d) throw fail(read.peekError(ErrorCode.TrailingComma));
      continue;
    }
    if (b === 0x5d) {
      read.discard();
      return { kind: 'array', start, items, end: read.index };
    }
    throw fail(read.peekError(ErrorCode.ExpectedListCommaOrEnd));
  }
}

function parseObjectNode(read, isTop = false) {
  const start = read.index;
  read.discard(); // `{`
  /** @type {{key: string, keyEnd: number, node: any}[]} */
  const entries = [];
  const fail = (err) => {
    if (isTop) err.partialNode = { kind: 'object', start, entries, incomplete: true, end: read.index };
    return err;
  };
  let b = skipWhitespace(read);
  if (b === null) throw fail(read.error(ErrorCode.EofWhileParsingObject));
  if (b === 0x7d) {
    read.discard();
    return { kind: 'object', start, entries, end: read.index };
  }
  while (true) {
    b = skipWhitespace(read);
    if (b === null) throw fail(read.error(ErrorCode.EofWhileParsingObject));
    if (b !== 0x22) throw fail(read.peekError(ErrorCode.KeyMustBeAString));
    read.discard();
    let key;
    let keyEnd;
    try {
      key = parseStringBody(read);
      keyEnd = read.index;
      b = skipWhitespace(read);
      if (b === null) throw read.error(ErrorCode.EofWhileParsingObject);
      if (b !== 0x3a) throw read.peekError(ErrorCode.ExpectedColon);
      read.discard();
      entries.push({ key, keyEnd, node: parseValueNode(read) });
    } catch (err) {
      throw fail(err);
    }
    b = skipWhitespace(read);
    if (b === null) throw fail(read.error(ErrorCode.EofWhileParsingObject));
    if (b === 0x2c) {
      read.discard();
      const nb = skipWhitespace(read);
      if (nb === 0x7d) throw fail(read.peekError(ErrorCode.TrailingComma));
      continue;
    }
    if (b === 0x7d) {
      read.discard();
      return { kind: 'object', start, entries, end: read.index };
    }
    throw fail(read.peekError(ErrorCode.ExpectedObjectCommaOrEnd));
  }
}

/**
 * Parse a whole document.
 *
 * `serde_json::from_slice` runs `deserialize` and only then `end()`, so both
 * the trailing-content check and any syntax error past the last field the
 * visitor consumed are *deferred*: the caller raises them only once typed
 * deserialization has otherwise succeeded.
 *
 * @param {Uint8Array} bytes
 * @returns {{node: any, read: SliceRead, deferred: SerdeJsonError|null}}
 */
export function parseDocument(bytes) {
  const read = new SliceRead(bytes);
  let node;
  try {
    node = parseValueNode(read, true);
  } catch (err) {
    if (err.partialNode) return { node: err.partialNode, read, deferred: err };
    throw err;
  }
  const rest = skipWhitespace(read);
  const deferred = rest !== null ? read.peekError(ErrorCode.TrailingCharacters) : null;
  return { node, read, deferred };
}

/** Strip position metadata, yielding a plain `serde_json::Value`. */
export function nodeToValue(node) {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': return node.value;
    case 'number': return node.value;
    case 'string': return node.value;
    case 'array': return node.items.map(nodeToValue);
    case 'object': {
      // `serde_json::Value` is a `BTreeMap`, so a duplicate key keeps the
      // *last* occurrence — `BTreeMap::insert` overwrites.
      const map = new JsonMap();
      for (const { key, node: child } of node.entries) map.set(key, nodeToValue(child));
      return map;
    }
    default:
      throw new TypeError(`unknown node kind ${node.kind}`);
  }
}

export { SliceRead };
