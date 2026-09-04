/**
 * The `tool.v1.request.describe` response.
 *
 * Migration note: in Rust this is produced at runtime by `schemars`
 * (`SchemaGenerator::default().into_root_schema_for::<SparkConfig>()`), then
 * patched by the `#[capsule]` macro with a `mutable` extension and the tool's
 * doc comment as the description. `SparkConfig` has no generics and no
 * conditional fields, so the generated document is a constant — reproduced
 * here as data rather than by porting `schemars`.
 *
 * The exact bytes were captured from the compiled WebAssembly oracle, and the
 * differential harness re-checks them on every run.
 */

import { JsonMap, jsonMap, toJsonString } from './rust/json-value.js';

/** Doc comment on `IdentityBuilder::save_identity`, newlines preserved. */
const SAVE_IDENTITY_DESCRIPTION = [
  "Save the agent's identity. Called by the LLM after onboarding to",
  'persist the chosen callsign, personality, and style. Writes both',
  'KV state (for immediate use) and spark.toml (for persistence',
  'across KV resets).',
].join('\n');

/** Doc comments on `SparkConfig`'s fields, used as JSON Schema descriptions. */
const FIELD_DESCRIPTIONS = {
  callsign: 'Agent name/identifier.',
  class: 'Agent role description.',
  aura: 'Personality traits.',
  signal: 'Communication style preferences.',
  core: 'Core directives and constraints.',
};

function sparkConfigJsonSchema() {
  const properties = new JsonMap();
  for (const [name, description] of Object.entries(FIELD_DESCRIPTIONS)) {
    properties.set(name, jsonMap({ default: '', description, type: 'string' }));
  }

  return jsonMap({
    $schema: 'http://json-schema.org/draft-07/schema#',
    description: SAVE_IDENTITY_DESCRIPTION,
    mutable: false,
    properties,
    title: 'SparkConfig',
    type: 'object',
  });
}

/**
 * The full describe payload.
 *
 * The capsule has no `description` of its own (`capsule_desc` is `None`), which
 * the macro renders as an empty string rather than omitting the key.
 */
export function describeResponseJson() {
  return toJsonString(jsonMap({
    tools: [
      jsonMap({
        name: 'save_identity',
        description: SAVE_IDENTITY_DESCRIPTION,
        input_schema: sparkConfigJsonSchema(),
      }),
    ],
    description: '',
  }));
}

export { SAVE_IDENTITY_DESCRIPTION };
