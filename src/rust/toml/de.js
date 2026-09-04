/**
 * Port of `toml::from_str` (the `toml_edit` parser plus `toml`'s serde layer).
 *
 * Migration note: the capsule logs parse failures verbatim —
 *
 *     Failed to parse home://.config/spark.toml during auto-detect: {e}
 *
 * — and `toml_edit::TomlError`'s `Display` is a three-line annotated snippet,
 * not a one-liner. Both the *decision* (which documents parse) and the *text*
 * of the failure are therefore observable, so neither a permissive nor a
 * stricter off-the-shelf JavaScript TOML parser can stand in here.
 */

import { escapeDebugString, utf8Len } from '../str.js';

/** A parse failure carrying the character span `TomlError` renders a caret under. */
export class TomlParseError extends Error {
  constructor(message, spanStart, spanEnd) {
    super(message);
    this.name = 'TomlParseError';
    this.tomlMessage = message;
    this.spanStart = spanStart;
    this.spanEnd = spanEnd;
  }
}

const ENCODER = new TextEncoder();
const STRICT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NEWLINE_BYTE = 0x0a;

/**
 * Port of `toml_edit::error::translate_position`.
 *
 * Returns a 0-based `(line, column)` for a BYTE offset, including the
 * "one past the end" case, which the caret rendering relies on.
 */
function translatePosition(bytes, index) {
  if (bytes.length === 0) return { line: 0, column: index };
  const safeIndex = Math.min(index, bytes.length - 1);
  const columnOffset = index - safeIndex;

  // Rust scans `input[0..index]`, which excludes the byte at `index` itself.
  // That exclusion is load-bearing: when the offending byte *is* the newline
  // the error still belongs to the line the newline terminates, not the next.
  let lineStart = 0;
  for (let i = safeIndex - 1; i >= 0; i -= 1) {
    if (bytes[i] === NEWLINE_BYTE) {
      lineStart = i + 1;
      break;
    }
  }
  let line = 0;
  for (let i = 0; i < lineStart; i += 1) {
    if (bytes[i] === NEWLINE_BYTE) line += 1;
  }

  // The column is a CHARACTER count even though the index is a BYTE offset,
  // and Rust falls back to the raw byte distance when the slice ends inside a
  // multi-byte sequence.
  let column;
  try {
    column = Array.from(STRICT_DECODER.decode(bytes.subarray(lineStart, safeIndex + 1))).length - 1;
  } catch {
    column = safeIndex - lineStart;
  }
  return { line, column: column + columnOffset };
}

/**
 * Port of `impl Display for TomlError`.
 *
 * The gutter width, the caret run length, and the trailing newline are all
 * reproduced exactly; `highlight_len` is clamped to the remainder of the line
 * the same way the Rust impl clamps it.
 */
export function renderTomlError(raw, err) {
  const chars = Array.from(raw);
  const startByte = utf8Len(chars.slice(0, err.spanStart).join(''));
  const endByte = utf8Len(chars.slice(0, err.spanEnd).join(''));
  const { line, column } = translatePosition(ENCODER.encode(raw), startByte);
  const lineNum = line + 1;
  const colNum = column + 1;
  const gutter = String(lineNum).length;
  const content = raw.split('\n')[line] ?? '';
  // `TomlError` measures the highlight and the line width in BYTES (winnow's
  // `char_span` covers the whole UTF-8 char at the failure offset) while the
  // column is a CHAR count, so a 3-byte `\u672c` draws three carets.
  const contentLen = utf8Len(content);
  const highlightLen = Math.min(Math.max(endByte - startByte, 1), Math.max(contentLen - column, 0));

  let out = `TOML parse error at line ${lineNum}, column ${colNum}\n`;
  const pad = ' '.repeat(gutter + 1);
  out += `${pad}|\n`;
  out += `${lineNum} | ${content}\n`;
  out += `${pad}|`;
  out += ' '.repeat(column + 1);
  out += '^';
  for (let i = 1; i < highlightLen; i += 1) out += '^';
  out += '\n';
  out += `${err.tomlMessage}\n`;
  return out;
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;

class Cursor {
  constructor(chars) {
    this.chars = chars;
    this.i = 0;
  }

  get done() {
    return this.i >= this.chars.length;
  }

  peek(offset = 0) {
    return this.chars[this.i + offset];
  }

  startsWith(s) {
    for (let k = 0; k < s.length; k += 1) {
      if (this.chars[this.i + k] !== s[k]) return false;
    }
    return true;
  }

  fail(message, start = this.i, end = start + 1) {
    return new TomlParseError(message, start, end);
  }
}

function skipInlineSpace(cur) {
  while (!cur.done && (cur.peek() === ' ' || cur.peek() === '\t')) cur.i += 1;
}

function skipComment(cur) {
  if (cur.peek() !== '#') return;
  cur.i += 1;
  while (!cur.done && cur.peek() !== '\n') {
    const c = cur.peek();
    // A `\r` that begins a CRLF line ending closes the comment; a bare `\r` does not.
    if (c === '\r' && cur.peek(1) === '\n') break;
    // TOML `non-eol` is `%x09 / %x20-7E / non-ascii`, so a control character
    // inside a comment is a hard parse error. `toml_edit` reaches it through a
    // combinator that carries neither a label nor an `expected` list, so the
    // rendered message body is empty.
    if (c !== '\t' && (c < ' ' || c === '\u007f')) throw cur.fail('', cur.i);
    cur.i += 1;
  }
}

function skipNewlines(cur) {
  while (!cur.done) {
    const c = cur.peek();
    if (c === ' ' || c === '\t' || c === '\n') cur.i += 1;
    else if (c === '\r' && cur.peek(1) === '\n') cur.i += 2;
    else if (c === '#') skipComment(cur);
    else break;
  }
}

/** Consume the end of a line, which must hold nothing but space and a comment. */
function expectLineEnd(cur) {
  skipInlineSpace(cur);
  if (cur.done) return;
  if (cur.peek() === '#') {
    skipComment(cur);
    return;
  }
  if (cur.peek() === '\n') {
    cur.i += 1;
    return;
  }
  if (cur.peek() === '\r' && cur.peek(1) === '\n') {
    cur.i += 2;
    return;
  }
  throw cur.fail('expected newline, `#`');
}

const SHORT_UNESCAPE = new Map([
  ['b', '\b'],
  ['t', '\t'],
  ['n', '\n'],
  ['f', '\f'],
  ['r', '\r'],
  ['"', '"'],
  ['\\', '\\'],
]);

// toml_edit builds this with `.context(Label("escape sequence"))` followed by one
// `Expected(CharLiteral)` per legal escape; winnow renders the accumulated
// contexts as "invalid {label}\nexpected {a}, {b}, ...".
const INVALID_STRING = 'invalid string\nexpected `"`, `\'`';

const INVALID_ESCAPE = 'invalid escape sequence\nexpected `b`, `f`, `n`, `r`, `t`, `u`, `U`, `\\`, `"`';

/**
 * Build the failure for an unrecognised escape sequence, with `cur` parked on
 * the character that follows the backslash.
 *
 * `toml_edit` parses over `&BStr`, so winnow's `any` consumes a single BYTE and
 * the failure offset lands one byte past the escape character. `char_span()`
 * then snaps that offset back to the enclosing UTF-8 character boundary and
 * spans that whole character. For a one-byte escape character the snapped span
 * is therefore the FOLLOWING character; for a multi-byte one it collapses onto
 * the escape character itself.
 *
 * @param {Cursor} cur
 * @returns {TomlParseError}
 */
function invalidEscape(cur) {
  const escapeChar = cur.chars[cur.i];
  const start = escapeChar !== undefined && utf8Len(escapeChar) === 1 ? cur.i + 1 : cur.i;
  return cur.fail(INVALID_ESCAPE, start, start + 1);
}

function readUnicodeEscape(cur, digits, label) {
  // `hexescape::<N>` is a single `take_while(N..=N, is_hex_digit)`; winnow
  // backtracks the whole combinator on a short run, so a truncated escape is
  // always reported at the first hex position, never at the offending char.
  const start = cur.i;
  let n = 0;
  for (let k = 0; k < digits; k += 1) {
    const c = cur.peek();
    if (c === undefined || !/[0-9A-Fa-f]/.test(c)) throw cur.fail(`invalid ${label}`, start);
    n = n * 16 + parseInt(c, 16);
    cur.i += 1;
  }
  if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw cur.fail(`invalid ${label}`, start);
  return String.fromCodePoint(n);
}

function parseBasicString(cur, label = 'basic string') {
  cur.i += 1; // opening quote
  let out = '';
  while (true) {
    if (cur.done) throw cur.fail(`invalid ${label}`, cur.i);
    const c = cur.peek();
    if (c === '"') {
      cur.i += 1;
      return out;
    }
    if (c === '\n') throw cur.fail(`invalid ${label}`, cur.i);
    if (c === '\\') {
      cur.i += 1;
      const e = cur.peek();
      if (e === undefined) throw cur.fail('invalid escape sequence', cur.i);
      if (SHORT_UNESCAPE.has(e)) {
        out += SHORT_UNESCAPE.get(e);
        cur.i += 1;
        continue;
      }
      if (e === 'u') {
        cur.i += 1;
        out += readUnicodeEscape(cur, 4, 'unicode 4-digit hex code');
        continue;
      }
      if (e === 'U') {
        cur.i += 1;
        out += readUnicodeEscape(cur, 8, 'unicode 8-digit hex code');
        continue;
      }
      throw invalidEscape(cur);
    }
    const cp = c.codePointAt(0);
    if (cp <= 0x08 || (cp >= 0x0a && cp <= 0x1f) || cp === 0x7f) {
      throw cur.fail(`invalid ${label}`, cur.i);
    }
    out += c;
    cur.i += 1;
  }
}

function parseMultilineBasicString(cur) {
  cur.i += 3;
  if (cur.peek() === '\n') cur.i += 1;
  else if (cur.peek() === '\r' && cur.peek(1) === '\n') cur.i += 2;
  let out = '';
  while (true) {
    if (cur.done) throw cur.fail('invalid multiline basic string', cur.i);
    if (cur.startsWith('"""')) {
      cur.i += 3;
      // TOML allows up to two extra quotes to hug the closing delimiter.
      let extra = 0;
      while (extra < 2 && cur.peek() === '"') {
        out += '"';
        cur.i += 1;
        extra += 1;
      }
      return out;
    }
    const c = cur.peek();
    // Inside a multiline basic string only tab, newline and CRLF are legal
    // control characters; a bare `\r` fails at the `\r` itself.
    if (c !== '\t' && c !== '\n' && (c < ' ' || c === '\u007f') && !(c === '\r' && cur.peek(1) === '\n')) {
      throw cur.fail('invalid multiline basic string', cur.i);
    }
    if (c === '\\') {
      const e = cur.peek(1);
      if (e === '\n' || e === ' ' || e === '\t' || (e === '\r' && cur.peek(2) === '\n')) {
        // Line-ending backslash: trim the newline and all following whitespace.
        let j = cur.i + 1;
        while (j < cur.chars.length && (cur.chars[j] === ' ' || cur.chars[j] === '\t')) j += 1;
        if (cur.chars[j] === '\r' && cur.chars[j + 1] === '\n') j += 2;
        else if (cur.chars[j] === '\n') j += 1;
        else throw cur.fail('invalid escape sequence', cur.i + 1);
        while (j < cur.chars.length && ' \t\n\r'.includes(cur.chars[j])) j += 1;
        cur.i = j;
        continue;
      }
      cur.i += 1;
      const esc = cur.peek();
      if (esc !== undefined && SHORT_UNESCAPE.has(esc)) {
        out += SHORT_UNESCAPE.get(esc);
        cur.i += 1;
        continue;
      }
      if (esc === 'u') {
        cur.i += 1;
        out += readUnicodeEscape(cur, 4, 'unicode 4-digit hex code');
        continue;
      }
      if (esc === 'U') {
        cur.i += 1;
        out += readUnicodeEscape(cur, 8, 'unicode 8-digit hex code');
        continue;
      }
      throw invalidEscape(cur);
    }
    const cp = c.codePointAt(0);
    if (cp <= 0x08 || (cp >= 0x0b && cp <= 0x1f && cp !== 0x0d) || cp === 0x7f) {
      throw cur.fail('invalid multiline basic string', cur.i);
    }
    out += c;
    cur.i += 1;
  }
}

function parseLiteralString(cur) {
  cur.i += 1;
  let out = '';
  while (true) {
    if (cur.done) throw cur.fail('invalid literal string', cur.i);
    const c = cur.peek();
    if (c === "'") {
      cur.i += 1;
      return out;
    }
    // TOML's literal-char set is `%x09 / %x20-26 / %x28-7E / non-ascii`, so
    // every control byte except tab terminates the run and fails the closing
    // quote one position later, where winnow's `any` has already advanced.
    if (c !== '\t' && c < ' ') throw cur.fail('invalid literal string', cur.i);
    out += c;
    cur.i += 1;
  }
}

function parseMultilineLiteralString(cur) {
  cur.i += 3;
  if (cur.peek() === '\n') cur.i += 1;
  else if (cur.peek() === '\r' && cur.peek(1) === '\n') cur.i += 2;
  let out = '';
  while (true) {
    if (cur.done) throw cur.fail('invalid multiline literal string', cur.i);
    if (cur.startsWith("'''")) {
      cur.i += 3;
      let extra = 0;
      while (extra < 2 && cur.peek() === "'") {
        out += "'";
        cur.i += 1;
        extra += 1;
      }
      return out;
    }
    out += cur.peek();
    cur.i += 1;
  }
}

function parseKeySegment(cur) {
  const c = cur.peek();
  if (c === '"') return parseBasicString(cur);
  if (c === "'") return parseLiteralString(cur);
  if (c !== undefined && BARE_KEY_CHAR.test(c)) {
    let out = '';
    while (!cur.done && BARE_KEY_CHAR.test(cur.peek())) {
      out += cur.peek();
      cur.i += 1;
    }
    return out;
  }
  throw cur.fail('invalid key');
}

/** A dotted key path, e.g. `a.b.c`. */
function parseKeyPath(cur) {
  const path = [parseKeySegment(cur)];
  while (true) {
    skipInlineSpace(cur);
    if (cur.peek() !== '.') return path;
    cur.i += 1;
    skipInlineSpace(cur);
    path.push(parseKeySegment(cur));
  }
}

/** TOML values are tagged so `invalid type:` can name them the way serde does. */
const Kind = {
  String: 'string',
  Integer: 'integer',
  Float: 'float',
  Boolean: 'boolean',
  Datetime: 'datetime',
  Array: 'array',
  Table: 'table',
};

function tagged(kind, value, start, end) {
  return { kind, value, start, end };
}

const INTEGER_RE = /^[+-]?(0(?:x[0-9A-Fa-f_]+|o[0-7_]+|b[01_]+)|\d[\d_]*)/;

/**
 * Render an integer literal the way Rust renders `serde::de::Unexpected::Signed`
 * — always decimal — so `0x1f` reaches the error text as `31`, not `0x1f`.
 *
 * @param {string} literal
 * @returns {string}
 */
function integerDisplay(literal) {
  const text = literal.replace(/_/g, '').replace(/^\+/, '');
  const radix = /^(-?)0([xob])([0-9A-Fa-f]+)$/.exec(text);
  return radix ? `${radix[1]}${BigInt(`0${radix[2]}${radix[3]}`)}` : text;
}
const FLOAT_RE = /^[+-]?(\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?|nan|inf)/;
const SPECIAL_FLOAT_RE = /^[+-]?(inf|nan)/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(\.\d+)?/;

function parseValue(cur) {
  const start = cur.i;
  const c = cur.peek();
  if (c === undefined) throw cur.fail(INVALID_STRING, cur.i);

  if (c === '"') {
    const value = cur.startsWith('"""') ? parseMultilineBasicString(cur) : parseBasicString(cur);
    return tagged(Kind.String, value, start, cur.i);
  }
  if (c === "'") {
    const value = cur.startsWith("'''") ? parseMultilineLiteralString(cur) : parseLiteralString(cur);
    return tagged(Kind.String, value, start, cur.i);
  }
  if (c === '[') return parseArray(cur);
  if (c === '{') return parseInlineTable(cur);

  const rest = cur.chars.slice(cur.i).join('');
  if (rest.startsWith('true')) {
    cur.i += 4;
    return tagged(Kind.Boolean, true, start, cur.i);
  }
  if (rest.startsWith('false')) {
    cur.i += 5;
    return tagged(Kind.Boolean, false, start, cur.i);
  }

  // TOML's special floats. The stored value is the *rendered* token rather
  // than a JS number because serde's `Unexpected::Float` formats an f64 with
  // Rust's `{}`, which prints `inf`, `-inf` and `NaN` — none of which match
  // JS's `Infinity`/`-Infinity` stringification.
  const special = SPECIAL_FLOAT_RE.exec(rest);
  if (special) {
    cur.i += special[0].length;
    const token = special[0].endsWith('nan') ? 'NaN' : `${special[0][0] === '-' ? '-' : ''}inf`;
    return tagged(Kind.Float, token, start, cur.i);
  }

  const dt = DATETIME_RE.exec(rest);
  if (dt) {
    cur.i += dt[0].length;
    return tagged(Kind.Datetime, dt[0], start, cur.i);
  }
  const float = FLOAT_RE.exec(rest);
  const int = INTEGER_RE.exec(rest);
  if (float && (!int || float[0].length > int[0].length)) {
    cur.i += float[0].length;
    return tagged(Kind.Float, Number(float[0].replace(/_/g, '')), start, cur.i);
  }
  if (int) {
    cur.i += int[0].length;
    return tagged(Kind.Integer, integerDisplay(int[0]), start, cur.i);
  }
  throw cur.fail(INVALID_STRING, cur.i);
}

function parseArray(cur) {
  const start = cur.i;
  cur.i += 1;
  const items = [];
  while (true) {
    skipNewlines(cur);
    if (cur.done) throw cur.fail('invalid array', cur.i);
    if (cur.peek() === ']') {
      cur.i += 1;
      return tagged(Kind.Array, items, start, cur.i);
    }
    items.push(parseValue(cur));
    skipNewlines(cur);
    if (cur.peek() === ',') {
      cur.i += 1;
      continue;
    }
    if (cur.peek() === ']') {
      cur.i += 1;
      return tagged(Kind.Array, items, start, cur.i);
    }
    throw cur.fail('invalid array\nexpected `,`, `]`', cur.i);
  }
}

function parseInlineTable(cur) {
  const start = cur.i;
  cur.i += 1;
  const table = new Map();
  skipInlineSpace(cur);
  if (cur.peek() === '}') {
    cur.i += 1;
    return tagged(Kind.Table, table, start, cur.i);
  }
  while (true) {
    skipInlineSpace(cur);
    const keyStart = cur.i;
    const path = parseKeyPath(cur);
    skipInlineSpace(cur);
    if (cur.peek() !== '=') throw cur.fail('expected `.`, `=`', cur.i);
    cur.i += 1;
    skipInlineSpace(cur);
    const value = parseValue(cur);
    insertPath(cur, table, path, value, keyStart, 'inline table');
    skipInlineSpace(cur);
    if (cur.peek() === ',') {
      cur.i += 1;
      continue;
    }
    if (cur.peek() === '}') {
      cur.i += 1;
      return tagged(Kind.Table, table, start, cur.i);
    }
    throw cur.fail('invalid inline table\nexpected `,`, `}`', cur.i);
  }
}

function insertPath(cur, table, path, value, keyStart, context) {
  let node = table;
  for (let k = 0; k < path.length - 1; k += 1) {
    const seg = path[k];
    const existing = node.get(seg);
    if (existing === undefined) {
      const child = tagged(Kind.Table, new Map(), keyStart, keyStart);
      node.set(seg, child);
      node = child.value;
    } else if (existing.kind === Kind.Table) {
      node = existing.value;
    } else {
      throw cur.fail(`duplicate key \`${seg}\` in ${context}`, keyStart, keyStart + 1);
    }
  }
  const last = path[path.length - 1];
  if (node.has(last)) {
    throw cur.fail(`duplicate key \`${last}\` in ${context}`, keyStart, keyStart + 1);
  }
  node.set(last, value);
}

/**
 * Parse a whole TOML document into a `Map` tree of tagged values.
 *
 * @param {string} raw
 * @returns {Map<string, any>}
 */
export function parseTomlDocument(raw) {
  const cur = new Cursor(Array.from(raw));
  // `toml_edit` consumes a leading BOM inside the parser instead of stripping it
  // from the input, so its spans stay relative to the ORIGINAL text. Advancing
  // the cursor rather than slicing keeps our indices aligned with the same raw
  // string that `renderTomlError` measures against.
  if (cur.peek() === '\uFEFF') cur.i += 1;
  const root = new Map();
  let current = root;
  let currentName = 'document root';

  while (true) {
    skipNewlines(cur);
    if (cur.done) break;

    // A bare `\r` is not TOML whitespace; only CRLF is. toml_edit reaches this
    // failure through a combinator carrying no label and no expected list, so
    // the rendered message is empty.
    if (cur.peek() === '\r') throw cur.fail('', cur.i);

    if (cur.peek() === '[') {
      const isArrayTable = cur.peek(1) === '[';
      cur.i += isArrayTable ? 2 : 1;
      skipInlineSpace(cur);
      const path = parseKeyPath(cur);
      skipInlineSpace(cur);
      if (isArrayTable) {
        if (!cur.startsWith(']]')) throw cur.fail('invalid table header\nexpected `.`, `]]`', cur.i);
        cur.i += 2;
      } else {
        if (cur.peek() !== ']') throw cur.fail('invalid table header\nexpected `.`, `]`', cur.i);
        cur.i += 1;
      }
      expectLineEnd(cur);

      let node = root;
      for (let k = 0; k < path.length; k += 1) {
        const seg = path[k];
        const isLast = k === path.length - 1;
        let existing = node.get(seg);
        if (existing === undefined) {
          existing = isLast && isArrayTable
            ? tagged(Kind.Array, [], cur.i, cur.i)
            : tagged(Kind.Table, new Map(), cur.i, cur.i);
          node.set(seg, existing);
        }
        if (isLast && isArrayTable) {
          const element = tagged(Kind.Table, new Map(), cur.i, cur.i);
          existing.value.push(element);
          node = element.value;
        } else if (existing.kind === Kind.Array) {
          node = existing.value[existing.value.length - 1].value;
        } else {
          node = existing.value;
        }
      }
      current = node;
      currentName = `table \`${path.join('.')}\``;
      continue;
    }

    const lineStart = cur.i;
    const path = parseKeyPath(cur);
    skipInlineSpace(cur);
    if (cur.peek() !== '=') throw cur.fail('expected `.`, `=`', cur.i);
    cur.i += 1;
    skipInlineSpace(cur);
    const value = parseValue(cur);
    insertPath(cur, current, path, value, lineStart, currentName);
    expectLineEnd(cur);
  }

  return root;
}

/** The name `serde::de::Unexpected` gives a TOML value. */
export function tomlTypeName(node) {
  switch (node.kind) {
    case Kind.String: return `string "${escapeDebugString(node.value)}"`;
    case Kind.Integer: return `integer \`${node.value}\``;
    case Kind.Float: return `floating point \`${node.value}\``;
    case Kind.Boolean: return `boolean \`${node.value}\``;
    // `toml`'s Deserializer surfaces a datetime as a single-entry map, so serde
    // reports `map` here rather than anything datetime-specific.
    case Kind.Datetime: return 'map';
    case Kind.Array: return 'sequence';
    case Kind.Table: return 'map';
    default: return 'unknown';
  }
}

export { Kind };
