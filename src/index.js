//! Identity capsule for Astrid OS.
//!
//! Owns the agent's identity (spark config) as persistent state. Builds
//! the system prompt on `spark.v1.request.build` requests. On first boot,
//! injects an onboarding instruction so the agent walks the user through
//! identity setup. Provides `/identity-export` and `/identity-import` CLI
//! commands.
//
// Migration note (Rust -> JavaScript):
// The Rust crate is compiled to a `cdylib` targeting
// `wasm32-unknown-unknown` and the `#[capsule(state)]` proc-macro emits
// the WIT `astrid-hook-trigger` / `run` / `astrid-install` /
// `astrid-upgrade` exports. JavaScript has no equivalent of a WIT
// component export table, so the same four entry points are exposed as
// plain named exports from this module and re-dispatched by
// `bin/capsule.js`. The observable behaviour of each entry point --
// arguments, returned `capsule-result`, published IPC payloads, log
// records and KV/FS side effects -- is preserved byte-for-byte.

export {
  astridHookTrigger,
  run,
  astridInstall,
  astridUpgrade,
  STATE_KEY,
  TOOL_RESULT_TOPIC,
} from './capsule.js';

export {
  IdentityBuilder,
  SparkConfig,
  parseSparkToml,
  DEFAULT_CALLSIGN,
  DEFAULT_CLASS,
  SPARK_CONFIG_PATH,
  ONBOARDING_PROMPT,
} from './identity.js';

export { describeResponseJson, SAVE_IDENTITY_DESCRIPTION } from './schema.js';

export { SysError, hostErr, fs, kv, ipc, log, installPanicHandler } from './sdk/index.js';

export { setHost, getHost, withHost } from './sdk/host.js';
