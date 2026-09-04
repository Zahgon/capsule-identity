/**
 * The `toml` crate's serde surface, narrowed to the two calls `src/lib.rs`
 * makes: `toml::to_string(&SparkConfig)` and `toml::from_str::<SparkConfig>`.
 */

import { SPARK_CONFIG_FIELDS } from '../serde.js';
import { Kind, TomlParseError, parseTomlDocument, renderTomlError, tomlTypeName } from './de.js';
import { toTomlString } from './ser.js';

/** A `toml::de::Error`, whose `Display` is the annotated snippet. */
export class TomlError extends Error {
  constructor(raw, parseError) {
    super(renderTomlError(raw, parseError));
    this.name = 'TomlError';
    this.raw = raw;
    this.parseError = parseError;
  }

  display() {
    return renderTomlError(this.raw, this.parseError);
  }
}

/** `toml::to_string(&SparkConfig)`. */
export function sparkConfigToToml(config) {
  return toTomlString(SPARK_CONFIG_FIELDS.map((key) => [key, config[key]]));
}

/**
 * `toml::from_str::<SparkConfig>(content)`.
 *
 * Unknown keys are ignored (`SparkConfig` does not set `deny_unknown_fields`)
 * and every field defaults to `""`, so the only way this fails is a malformed
 * document or a non-string value for one of the five known keys.
 *
 * @throws {TomlError}
 */
export function sparkConfigFromToml(content) {
  let doc;
  try {
    doc = parseTomlDocument(content);
  } catch (err) {
    if (err instanceof TomlParseError) throw new TomlError(content, err);
    throw err;
  }

  const out = {};
  for (const [key, node] of doc.entries()) {
    if (!SPARK_CONFIG_FIELDS.includes(key)) continue;
    if (node.kind !== Kind.String) {
      throw new TomlError(
        content,
        new TomlParseError(
          `invalid type: ${tomlTypeName(node)}, expected a string`,
          node.start,
          node.end,
        ),
      );
    }
    out[key] = node.value;
  }
  for (const key of SPARK_CONFIG_FIELDS) {
    if (!(key in out)) out[key] = '';
  }
  return out;
}
