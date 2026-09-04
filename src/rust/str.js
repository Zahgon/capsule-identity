/**
 * Rust `str` / `String` semantics that JavaScript does not provide natively.
 *
 * Migration note: every helper here exists because the JavaScript built-in that
 * *looks* equivalent is not. Each one documents the exact divergence it papers
 * over. Do not "simplify" these into their JS built-ins.
 */

const UTF8_ENCODER = new TextEncoder();

/**
 * Length of `s` in UTF-8 bytes.
 *
 * Rust's `String::len()` returns the UTF-8 byte length; JavaScript's
 * `String.prototype.length` returns the number of UTF-16 code units. The two
 * disagree for every non-ASCII character. The capsule reports
 * `"... ({n} bytes)"` from `toml.len()`, so this must be the byte count.
 */
export function utf8Len(s) {
  return UTF8_ENCODER.encode(s).length;
}

/**
 * The Unicode `White_Space=Yes` code points, which is exactly the set that
 * Rust's `char::is_whitespace` (and therefore `str::trim`) recognises.
 *
 * This deliberately differs from JavaScript's `String.prototype.trim`:
 *   - Rust trims U+0085 (NEXT LINE); JavaScript does not.
 *   - JavaScript trims U+FEFF (ZERO WIDTH NO-BREAK SPACE); Rust does not,
 *     because U+FEFF has `White_Space=No`.
 * `handle_command` dispatches on `text.trim()`, so an off-by-one-code-point
 * here changes which commands run.
 */
const RUST_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, // \t \n \v \f \r
  0x20, // SPACE
  0x85, // NEXT LINE
  0xa0, // NO-BREAK SPACE
  0x1680, // OGHAM SPACE MARK
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, // LINE SEPARATOR
  0x2029, // PARAGRAPH SEPARATOR
  0x202f, // NARROW NO-BREAK SPACE
  0x205f, // MEDIUM MATHEMATICAL SPACE
  0x3000, // IDEOGRAPHIC SPACE
]);

function isRustWhitespace(codePoint) {
  return RUST_WHITESPACE.has(codePoint);
}

/**
 * Port of Rust's `str::trim` (leading and trailing `char::is_whitespace`).
 *
 * Operates on code points, not UTF-16 code units, so surrogate pairs are never
 * split.
 */
export function rustTrim(s) {
  const chars = Array.from(s);
  let start = 0;
  let end = chars.length;
  while (start < end && isRustWhitespace(chars[start].codePointAt(0))) {
    start += 1;
  }
  while (end > start && isRustWhitespace(chars[end - 1].codePointAt(0))) {
    end -= 1;
  }
  return chars.slice(start, end).join('');
}

/**
 * Port of Rust's `str::trim_end_matches(char)`.
 *
 * Repeatedly strips the pattern from the end, so `"/a///"` becomes `"/a"`.
 * `String.prototype.replace(/\/+$/, '')` would be equivalent for this single
 * call site, but the explicit loop keeps the source's semantics legible.
 */
export function trimEndMatchesChar(s, ch) {
  let end = s.length;
  while (end >= ch.length && s.slice(end - ch.length, end) === ch) {
    end -= ch.length;
  }
  return s.slice(0, end);
}

/**
 * Byte-wise ordering of two JavaScript strings by their UTF-8 encodings.
 *
 * `BTreeMap<String, _>` orders keys with Rust's `Ord for String`, which is a
 * lexicographic comparison of UTF-8 bytes — equivalently, code point order.
 * JavaScript's default `Array.prototype.sort` compares UTF-16 code units, which
 * orders astral-plane characters (U+10000+) *before* U+E000..U+FFFF. That is a
 * real divergence for any object key containing an emoji, so `serde_json`
 * object key ordering must not use the default comparator.
 */
export function compareUtf8(a, b) {
  if (a === b) return 0;
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i += 1) {
    const ac = ai[i].codePointAt(0);
    const bc = bi[i].codePointAt(0);
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  if (ai.length === bi.length) return 0;
  return ai.length < bi.length ? -1 : 1;
}

/**
 * Port of Rust's `char::escape_debug` restricted to the cases `Debug for str`
 * can emit, used to reproduce `{:?}` formatting of strings.
 */
export function escapeDebugString(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === "'") out += "'";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}
