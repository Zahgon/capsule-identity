/**
 * Hand-written equivalents of the `#[derive(Deserialize)]` impls in
 * `src/lib.rs`, plus the two derives the `#[capsule]` macro generates.
 *
 * Migration note: these are not "parse an object and check some fields". A
 * derived `Deserialize` visits the map in *document* order, rejects a repeated
 * field the moment it reads the key, and only checks for missing fields once
 * the map is exhausted. Each of those steps produces a different message at a
 * different byte offset, and the capsule surfaces those messages verbatim
 * (`failed to parse arguments: {e}`), so the visiting order is observable and
 * is reproduced here exactly.
 */

import { JsonMap, serdeTypeName } from './json-value.js';
import { ErrorCode, SerdeJsonError, nodeToValue, parseDocument } from './json-parse.js';

const EXPECTED_STRING = 'a string';
const EXPECTED_BOOL = 'a boolean';

function nodeValueName(node) {
  switch (node.kind) {
    case 'null': return 'null';
    case 'bool': return `boolean \`${node.value}\``;
    case 'number': return `${node.value.typeName()} \`${node.value.display()}\``;
    case 'string': return serdeTypeName(node.value);
    case 'array': return 'sequence';
    case 'object': return 'map';
    default: return 'unknown';
  }
}

function positionedError(read, index, code) {
  const { line, column } = read.positionOfIndex(index);
  return new SerdeJsonError(code, line, column);
}

function invalidType(read, node, expected) {
  // `Deserializer::peek_invalid_type` consumes the offending value for every
  // scalar arm (so the position lands *after* it) but the `[` and `{` arms
  // return immediately, leaving the reader parked on the opening bracket.
  const index = node.kind === 'array' || node.kind === 'object' ? node.start : node.end;
  return positionedError(read, index ?? node.end, `invalid type: ${nodeValueName(node)}, expected ${expected}`);
}

function expectString(read, node) {
  if (node.kind !== 'string') throw invalidType(read, node, EXPECTED_STRING);
  return node.value;
}

function expectBool(read, node) {
  if (node.kind !== 'bool') throw invalidType(read, node, EXPECTED_BOOL);
  return node.value;
}

/**
 * `Option<T>`: `null` is `None`, anything else is `Some` and is deserialized
 * as `T` — so a wrong type inside an `Option` reports `T`'s expectation, not
 * "an option".
 */
function expectOptionString(read, node) {
  return node.kind === 'null' ? null : expectString(read, node);
}

/**
 * Drive a derived struct visitor over a parsed node.
 *
 * @param {object} spec
 * @param {string} spec.name struct name, as it appears in error messages
 * @param {{key: string, read: (read: any, node: any) => unknown, default?: () => unknown}[]} spec.fields
 *        in declaration order, which is the order `FIELDS` and the missing-field
 *        check both use
 * @param {any} node parsed document node
 * @param {any} read the reader, for position lookups
 * @param {SerdeJsonError|null} deferred syntax error the parser stopped on
 */
function deserializeStruct(spec, node, read, deferred) {
  const { name, fields } = spec;

  if (node.kind === 'object') {
    const seen = new Map();
    for (const entry of node.entries) {
      const field = fields.find((f) => f.key === entry.key);
      if (!field) continue; // serde skips unknown keys via `IgnoredAny`
      if (seen.has(entry.key)) {
        throw positionedError(read, entry.keyEnd, `duplicate field \`${entry.key}\``);
      }
      seen.set(entry.key, field.read(read, entry.node));
    }
    // The visitor only learns a field is missing after the map ends, so an
    // unterminated document surfaces the syntax error instead.
    if (node.incomplete && deferred) throw deferred;
    const out = {};
    for (const field of fields) {
      if (seen.has(field.key)) out[field.key] = seen.get(field.key);
      else if (field.default) out[field.key] = field.default();
      else throw positionedError(read, node.end, `missing field \`${field.key}\``);
    }
    return out;
  }

  // A derived visitor also implements `visit_seq`, so a JSON array is a valid
  // encoding of a struct: elements are matched to fields positionally. When the
  // sequence runs out, a `#[serde(default)]` field falls back to its default and
  // any other field fails with `invalid_length(field_index, ...)`.
  if (node.kind === 'array') {
    const out = {};
    for (let i = 0; i < fields.length; i += 1) {
      const item = node.items[i];
      if (item === undefined) {
        if (node.incomplete && deferred) throw deferred;
        if (!fields[i].default) {
          throw positionedError(
            read,
            node.end,
            `invalid length ${i}, expected struct ${name} with ${fields.length} elements`,
          );
        }
        out[fields[i].key] = fields[i].default();
        continue;
      }
      out[fields[i].key] = fields[i].read(read, item);
    }
    // `end_seq` eats the separator after the last field it wanted, then finds a
    // token where `]` should be, so the surplus is reported one character past
    // that token's start rather than at the array's end.
    const surplus = node.items[fields.length];
    if (surplus !== undefined) {
      throw positionedError(read, surplus.start + 1, ErrorCode.TrailingCharacters);
    }
    return out;
  }

  throw invalidType(read, node, `struct ${name}`);
}

/** `struct SparkConfig` — every field is `#[serde(default)]`. */
export const SPARK_CONFIG_FIELDS = ['callsign', 'class', 'aura', 'signal', 'core'];

const SPARK_CONFIG_SPEC = {
  name: 'SparkConfig',
  fields: SPARK_CONFIG_FIELDS.map((key) => ({
    key,
    read: expectString,
    default: () => '',
  })),
};

const BUILD_REQUEST_SPEC = {
  name: 'BuildRequest',
  fields: [
    { key: 'workspace_root', read: expectString },
    { key: 'session_id', read: expectOptionString, default: () => null },
  ],
};

const IDENTITY_BUILDER_SPEC = {
  name: 'IdentityBuilder',
  fields: [
    { key: 'spark', read: (read, node) => deserializeStruct(SPARK_CONFIG_SPEC, node, read, null) },
    { key: 'onboarded', read: expectBool },
  ],
};

const TOOL_EXEC_SPEC = {
  name: '__AstridToolExecPayload',
  fields: [
    { key: 'call_id', read: expectString },
    { key: 'tool_name', read: expectString },
    { key: 'arguments', read: (_read, node) => nodeToValue(node) },
  ],
};

/**
 * `serde_json::from_slice::<T>(bytes)`.
 *
 * The trailing-content check runs *after* deserialization, matching
 * `from_trait`'s `deserialize(); end()` ordering.
 */
function fromSlice(spec, bytes) {
  const { node, read, deferred } = parseDocument(bytes);
  const value = deserializeStruct(spec, node, read, deferred);
  if (deferred) throw deferred;
  return value;
}

export function buildRequestFromSlice(bytes) {
  return fromSlice(BUILD_REQUEST_SPEC, bytes);
}

export function toolExecPayloadFromSlice(bytes) {
  return fromSlice(TOOL_EXEC_SPEC, bytes);
}

export function identityBuilderFromSlice(bytes) {
  return fromSlice(IDENTITY_BUILDER_SPEC, bytes);
}

/** `serde_json::from_slice::<serde_json::Value>` — accepts any valid document. */
export function valueFromSlice(bytes) {
  const { node, deferred } = parseDocument(bytes);
  if (deferred) throw deferred;
  return nodeToValue(node);
}

/**
 * `serde_json::from_value::<SparkConfig>(value)`.
 *
 * Errors raised here carry no position: `from_value` deserializes an in-memory
 * `Value`, so `Error::line` stays 0 and `Display` omits the ` at line …`
 * suffix. That is why a bad `arguments` payload reports
 * `invalid type: null, expected struct SparkConfig` with no trailing position.
 */
export function sparkConfigFromValue(value) {
  const positionless = (code) => new SerdeJsonError(code, 0, 0);

  if (Array.isArray(value)) {
    const out = {};
    SPARK_CONFIG_FIELDS.forEach((key, i) => {
      const item = value[i];
      if (item === undefined) out[key] = '';
      else if (typeof item !== 'string') {
        throw positionless(`invalid type: ${serdeTypeName(item)}, expected ${EXPECTED_STRING}`);
      } else out[key] = item;
    });
    // `SeqDeserializer::end` runs after the visitor has taken its five fields
    // and rejects anything left over, so a longer array is an error rather
    // than a prefix match. `len` is the whole array's length, not the surplus.
    if (value.length > SPARK_CONFIG_FIELDS.length) {
      throw positionless(`invalid length ${value.length}, expected fewer elements in array`);
    }
    return out;
  }

  if (!(value instanceof JsonMap)) {
    throw positionless(`invalid type: ${serdeTypeName(value)}, expected struct SparkConfig`);
  }

  const out = {};
  // `Value::Object` is a `BTreeMap`, so `from_value` visits keys in sorted
  // order — which decides *which* field's type error is reported first.
  for (const [key, entry] of value.sortedEntries()) {
    if (!SPARK_CONFIG_FIELDS.includes(key)) continue;
    if (typeof entry !== 'string') {
      throw positionless(`invalid type: ${serdeTypeName(entry)}, expected ${EXPECTED_STRING}`);
    }
    out[key] = entry;
  }
  for (const key of SPARK_CONFIG_FIELDS) {
    if (!(key in out)) out[key] = '';
  }
  return out;
}
