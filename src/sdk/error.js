/**
 * Port of `astrid_sdk::SysError` and its `Display`/`Debug` impls.
 *
 * Migration note: every variant's rendered text reaches the outside world. A
 * host failure becomes the `data` of a `deny` result, the `content` of a failed
 * tool call, or part of a `log::warn` line, so the exact prefixes below are the
 * contract — not decoration.
 */

/** Rust `{:?}` for a `String`. */
function debugQuote(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * Rust `{:?}` for one of the WIT `error-code` enums.
 *
 * The WIT kebab-case variant names are generated as UpperCamelCase Rust
 * variants, and `host_err` formats them with `{:?}`, so `not-found` surfaces to
 * the user as `ErrorCode::NotFound`.
 */
export function errorCodeDebug(code, detail) {
  const camel = String(code)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return camel === 'Unknown'
    ? `ErrorCode::Unknown(${debugQuote(detail ?? '')})`
    : `ErrorCode::${camel}`;
}

export class SysError extends Error {
  constructor(variant, payload, text) {
    super(text);
    this.name = 'SysError';
    this.variant = variant;
    this.payload = payload;
    this.text = text;
  }

  /** `impl Display for SysError`. */
  display() {
    return this.text;
  }

  /** `impl Debug for SysError` — the derived tuple-struct form. */
  debug() {
    switch (this.variant) {
      case 'HostError': return `HostError(${debugQuote(this.payload)})`;
      case 'ApiError': return `ApiError(${debugQuote(this.payload)})`;
      case 'JsonError': return `JsonError(Error(${debugQuote(this.payload)}))`;
      default: return `${this.variant}(${debugQuote(String(this.payload))})`;
    }
  }

  static hostError(debugText) {
    return new SysError('HostError', debugText, `Host function call failed: ${debugText}`);
  }

  static jsonError(serdeError) {
    return new SysError(
      'JsonError',
      serdeError.display(),
      `JSON serialization error: ${serdeError.display()}`,
    );
  }

  static apiError(message) {
    return new SysError('ApiError', message, `API logic error: ${message}`);
  }
}

/** Port of `astrid_sdk::host_err`. */
export function hostErr(err) {
  return SysError.hostError(errorCodeDebug(err.code, err.detail));
}
