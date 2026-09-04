/**
 * Port of `toml`'s value serializer (`toml_write::string`).
 *
 * Migration note: `toml::to_string(&SparkConfig)` output is written to
 * `home://.config/spark.toml` and its **byte length** is reported back to the
 * user (`Identity exported to … (88 bytes)`), so the choice of quoting style is
 * observable. There is no JavaScript TOML writer that reproduces `toml_write`'s
 * particular heuristic, so it is ported literally, including its quirks:
 *
 *   - `\t` and `\n` are *not* counted as "escape codes" when picking a style,
 *     because the style chooser matches them before its control-character arm.
 *   - A multi-line string that contains a newline gets a newline inserted right
 *     after the opening `"""`/`'''`.
 *   - Control characters with no short escape are emitted as `\uXXXX` with
 *     **uppercase** hex digits.
 */

const BACKSLASH = 0x5c;
const TAB = 0x09;
const NEWLINE = 0x0a;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const DEL = 0x7f;

const ENCODER = new TextEncoder();
// See `src/sdk/index.js`: `ignoreBOM: true` preserves a leading U+FEFF, which a
// serialized TOML string value is allowed to contain as an ordinary character.
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

/** Port of `toml_write::string::ValueMetrics::calculate`. */
function valueMetrics(bytes) {
  const metrics = {
    maxSeqSingleQuotes: 0,
    maxSeqDoubleQuotes: 0,
    escape: false,
    newline: false,
    escapeCodes: false,
  };
  let runSingle = 0;
  let runDouble = 0;
  for (const b of bytes) {
    if (b === SINGLE_QUOTE) {
      runSingle += 1;
      metrics.maxSeqSingleQuotes = Math.max(metrics.maxSeqSingleQuotes, runSingle);
    } else {
      runSingle = 0;
    }
    if (b === DOUBLE_QUOTE) {
      runDouble += 1;
      metrics.maxSeqDoubleQuotes = Math.max(metrics.maxSeqDoubleQuotes, runDouble);
    } else {
      runDouble = 0;
    }

    if (b === BACKSLASH) metrics.escape = true;
    else if (b === TAB) continue;
    else if (b === NEWLINE) metrics.newline = true;
    else if (b <= 0x1f || b === DEL) metrics.escapeCodes = true;
  }
  return metrics;
}

const Encoding = {
  Basic: 'basic',
  Literal: 'literal',
  MlBasic: 'ml-basic',
  MlLiteral: 'ml-literal',
};

/** Port of `TomlStringBuilder::as_default`. */
function chooseEncoding(m) {
  if (!m.escapeCodes && !m.escape && m.maxSeqDoubleQuotes === 0 && !m.newline) return Encoding.Basic;
  if (!m.escapeCodes && m.maxSeqSingleQuotes === 0 && !m.newline) return Encoding.Literal;
  if (!m.escapeCodes && !m.escape && m.maxSeqDoubleQuotes <= 2) return Encoding.MlBasic;
  if (!m.escapeCodes && m.maxSeqSingleQuotes <= 2) return Encoding.MlLiteral;
  return m.newline ? Encoding.MlBasic : Encoding.Basic;
}

function delimiterFor(encoding) {
  switch (encoding) {
    case Encoding.Basic: return '"';
    case Encoding.Literal: return "'";
    case Encoding.MlBasic: return '"""';
    case Encoding.MlLiteral: return "'''";
    default: throw new TypeError(`unknown encoding ${encoding}`);
  }
}

const SHORT_ESCAPES = new Map([
  [0x08, '\\b'],
  [TAB, '\\t'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [BACKSLASH, '\\\\'],
]);

/**
 * Escape a string body for the basic / multi-line-basic encodings.
 *
 * Runs over UTF-8 bytes: every byte that needs escaping is ASCII, and bytes
 * >= 0x80 are passed through untouched, so multi-byte characters survive.
 */
function escapeBody(bytes, isMultiline) {
  const allowedDoubleQuotes = isMultiline ? 2 : 0;
  let out = '';
  let pending = [];
  let runDouble = 0;

  const flush = () => {
    if (pending.length > 0) {
      out += DECODER.decode(Uint8Array.from(pending));
      pending = [];
    }
  };

  for (const b of bytes) {
    if (b === DOUBLE_QUOTE) {
      runDouble += 1;
      if (runDouble > allowedDoubleQuotes) {
        flush();
        out += '\\"';
        runDouble = 0;
        continue;
      }
      pending.push(b);
      continue;
    }
    runDouble = 0;

    const short = SHORT_ESCAPES.get(b);
    if (short !== undefined) {
      flush();
      out += short;
      continue;
    }
    if (b === NEWLINE) {
      if (isMultiline) {
        pending.push(b);
      } else {
        flush();
        out += '\\n';
      }
      continue;
    }
    if (b <= 0x1f || b === DEL) {
      flush();
      out += `\\u${b.toString(16).toUpperCase().padStart(4, '0')}`;
      continue;
    }
    pending.push(b);
  }
  flush();
  return out;
}

/** Port of `toml_write::TomlWrite::value` for a string. */
export function tomlString(value) {
  const bytes = ENCODER.encode(value);
  const metrics = valueMetrics(bytes);
  const encoding = chooseEncoding(metrics);
  const delimiter = delimiterFor(encoding);
  const isMultiline = encoding === Encoding.MlBasic || encoding === Encoding.MlLiteral;
  const isEscaped = encoding === Encoding.Basic || encoding === Encoding.MlBasic;

  const prefix = metrics.newline && isMultiline ? '\n' : '';
  const body = isEscaped ? escapeBody(bytes, isMultiline) : value;
  return `${delimiter}${prefix}${body}${delimiter}`;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** Port of `TomlKeyBuilder::as_default`. */
export function tomlKey(key) {
  if (BARE_KEY.test(key)) return key;
  const metrics = valueMetrics(ENCODER.encode(key));
  if (!metrics.escapeCodes && !metrics.escape && metrics.maxSeqDoubleQuotes === 0 && !metrics.newline) {
    return `"${key}"`;
  }
  if (!metrics.escapeCodes && metrics.maxSeqSingleQuotes === 0 && !metrics.newline) {
    return `'${key}'`;
  }
  return `"${escapeBody(ENCODER.encode(key), false)}"`;
}

/**
 * `toml::to_string` for a flat table of string-valued fields.
 *
 * Fields are emitted in declaration order — `toml`'s `Serializer` follows
 * `Serialize`, so this is the struct's field order, not sorted order.
 */
export function toTomlString(fields) {
  let out = '';
  for (const [key, value] of fields) {
    out += `${tomlKey(key)} = ${tomlString(value)}\n`;
  }
  return out;
}
