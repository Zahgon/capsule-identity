/**
 * Identity capsule for Astrid OS.
 *
 * Owns the agent's identity (spark config) as persistent state. Builds the
 * system prompt on `spark.v1.request.build` requests. On first boot, injects an
 * onboarding instruction so the agent walks the user through identity setup.
 * Provides `/identity-export` and `/identity-import` CLI commands.
 */

import { fs, ipc, log } from './sdk/index.js';
import { asStr, jsonMap, jsonStructString, rawJson, toJsonString, valueGet } from './rust/json-value.js';
import { rustTrim, trimEndMatchesChar, utf8Len } from './rust/str.js';
import { sparkConfigFromToml, sparkConfigToToml } from './rust/toml/index.js';
import { SPARK_CONFIG_FIELDS } from './rust/serde.js';

/** Default agent name when no callsign has been configured. */
const DEFAULT_CALLSIGN = 'Astrid';

/** Where the identity is mirrored on disk, outside the KV store. */
export const SPARK_CONFIG_PATH = 'home://.config/spark.toml';

/** Default role description. */
const DEFAULT_CLASS = 'a secure coding assistant';

/**
 * Instruction injected on first boot, before any identity exists.
 *
 * The em dashes are U+2014 and there is no trailing newline; this text is
 * compared against verbatim by the ported tests and by the differential
 * harness.
 */
const ONBOARDING_PROMPT = `# Important: Identity Setup Required

This is your first session. You have no name or identity yet. Introduce
yourself briefly, then ask the user one open question about how they'd like
to work together. Let the conversation flow naturally. From it, derive a name,
personality, and focus that feel right — then surface what you came up with
and let the user react. Adjust from there. Once you've landed on something,
call \`save_identity\` to save it. Always call it — if the user wants to skip,
derive something fitting from the exchange and confirm it casually before saving.`;

/** Agent identity configuration. */
export const SparkConfig = {
  /** `impl Default for SparkConfig`. */
  default() {
    return {
      callsign: DEFAULT_CALLSIGN,
      class: DEFAULT_CLASS,
      aura: '',
      signal: '',
      core: '',
    };
  },

  /** Compose the opening lines of the system prompt from the identity. */
  buildPreamble(self) {
    const callsign = self.callsign === '' ? DEFAULT_CALLSIGN : self.callsign;

    const parts = [];
    if (self.class !== '') parts.push(`You are ${callsign}, ${self.class}.`);
    else parts.push(`You are ${callsign}.`);

    if (self.aura !== '') parts.push(`# Personality\n${self.aura}`);
    if (self.signal !== '') parts.push(`# Communication Style\n${self.signal}`);
    if (self.core !== '') parts.push(`# Core Directives\n${self.core}`);

    return parts.join('\n\n');
  },

  /**
   * `toml::to_string(self).unwrap_or_default()`.
   *
   * Serializing five plain strings cannot fail, so the `unwrap_or_default`
   * fallback to `""` is unreachable in practice — it is kept so the failure
   * mode matches the source rather than throwing.
   */
  toToml(self) {
    try {
      return sparkConfigToToml(self);
    } catch {
      return '';
    }
  },

  /** `#[derive(Serialize)]` — declaration order, not sorted. */
  serialize(self) {
    return jsonStructString(SPARK_CONFIG_FIELDS.map((key) => [key, self[key]]));
  },
};

/**
 * `fn parse_spark_toml(content: &str) -> SparkConfig`
 *
 * A malformed document is logged and replaced with the default identity.
 */
export function parseSparkToml(content) {
  try {
    return sparkConfigFromToml(content);
  } catch (err) {
    log.warn(`Failed to parse spark.toml, using defaults: ${err.display()}`);
    return SparkConfig.default();
  }
}

/** The capsule's persistent state. */
export class IdentityBuilder {
  constructor(spark = SparkConfig.default(), onboarded = false) {
    this.spark = spark;
    this.onboarded = onboarded;
  }

  /**
   * `#[derive(Default)]` on a struct whose field type has a hand-written
   * `Default` impl: the field is `SparkConfig::default()`, i.e. the *populated*
   * identity, not five empty strings.
   */
  static default() {
    return new IdentityBuilder(SparkConfig.default(), false);
  }

  /** `#[derive(Serialize)]` — field order is `spark`, then `onboarded`. */
  serialize() {
    return jsonStructString([
      ['spark', rawJson(SparkConfig.serialize(this.spark))],
      ['onboarded', this.onboarded],
    ]);
  }

  /**
   * `#[astrid::interceptor("handle_build_request")]`
   *
   * @param {{workspace_root: string, session_id: string|null}} req
   */
  buildSystemPrompt(req) {
    const workspaceRoot = trimEndMatchesChar(req.workspace_root, '/');
    const prompt = this.buildPromptText(workspaceRoot);

    ipc.publishJson(
      'spark.v1.response.ready',
      buildResponseJson(prompt, req.session_id),
    );
  }

  buildPromptText(workspaceRoot) {
    return this.buildPromptTextWithSparkLoader(workspaceRoot, () => {
      try {
        return fs.readToString(SPARK_CONFIG_PATH);
      } catch {
        return null; // `.ok()` — a read failure is indistinguishable from "absent"
      }
    });
  }

  /**
   * @param {string} workspaceRoot
   * @param {() => string|null} loadSpark
   */
  buildPromptTextWithSparkLoader(workspaceRoot, loadSpark) {
    // TODO: Move to a new capsule which handles env details. Time would be good too.
    let prompt = `# Environment\n- Current working directory: ${workspaceRoot}\n- Platform: astrid-os`;

    // Auto-detect a spark.toml written by a previous install even when the KV
    // state has been reset. A stub file with an empty callsign is ignored, so a
    // half-written config cannot short-circuit onboarding. This keeps the
    // capsule resilient to KV resets without a migration step.
    if (!this.onboarded) {
      const content = loadSpark();
      if (content !== null && content !== undefined) {
        try {
          const config = sparkConfigFromToml(content);
          if (config.callsign !== '') {
            this.spark = config;
            this.onboarded = true;
          }
        } catch (err) {
          log.warn(`Failed to parse ${SPARK_CONFIG_PATH} during auto-detect: ${err.display()}`);
        }
      }
    }

    if (this.onboarded) {
      prompt = `${SparkConfig.buildPreamble(this.spark)}\n\n${prompt}`;
    } else {
      prompt += '\n\n';
      prompt += ONBOARDING_PROMPT;
    }

    return prompt;
  }

  /** `#[astrid::interceptor("handle_command")]` */
  handleCommand(payload) {
    const text = asStr(valueGet(payload, 'text')) ?? '';
    const sessionId = asStr(valueGet(payload, 'session_id')) ?? 'default';
    const sparkPath = SPARK_CONFIG_PATH;

    switch (rustTrim(text)) {
      case 'identity-export': {
        const toml = SparkConfig.toToml(this.spark);
        fs.write(sparkPath, new TextEncoder().encode(toml));

        ipc.publishJson('agent.v1.response', toJsonString(jsonMap({
          type: 'agent_response',
          text: `Identity exported to ${sparkPath} (${utf8Len(toml)} bytes)`,
          is_final: true,
          session_id: sessionId,
        })));
        break;
      }
      case 'identity-import': {
        const content = fs.readToString(sparkPath);
        this.spark = parseSparkToml(content);
        this.onboarded = true;

        ipc.publishJson('agent.v1.response', toJsonString(jsonMap({
          type: 'agent_response',
          text: `Identity imported from ${sparkPath} (callsign: ${this.spark.callsign})`,
          is_final: true,
          session_id: sessionId,
        })));
        break;
      }
      default:
        break;
    }
  }

  /**
   * `#[astrid::tool("save_identity")]`
   *
   * State is mutated *before* the file write, so a write failure still leaves
   * the new identity in memory — the macro then declines to persist it.
   */
  saveIdentity(args) {
    this.spark = args;
    this.onboarded = true;

    const toml = SparkConfig.toToml(this.spark);
    fs.write(SPARK_CONFIG_PATH, new TextEncoder().encode(toml));

    return jsonMap({ status: 'ok', callsign: this.spark.callsign });
  }
}

/**
 * `struct BuildResponse` — `session_id` is
 * `#[serde(skip_serializing_if = "Option::is_none")]`, so a `None` drops the
 * key entirely rather than emitting `null`.
 */
function buildResponseJson(prompt, sessionId) {
  const fields = [['prompt', prompt]];
  if (sessionId !== null && sessionId !== undefined) fields.push(['session_id', sessionId]);
  return jsonStructString(fields);
}

export { ONBOARDING_PROMPT, DEFAULT_CALLSIGN, DEFAULT_CLASS };
