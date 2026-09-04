/**
 * The capsule ABI — a port of the code `#[capsule(state)]` generates.
 *
 * Migration note: roughly two thirds of this capsule's observable behaviour
 * never appears in `src/lib.rs`. Loading `__state`, choosing `deny` over
 * `continue`, deciding *when* state is persisted, and wrapping tool results in
 * an envelope are all emitted by the `astrid-sdk-macros` proc macro. The
 * control flow below was recovered with `cargo expand` and verified against the
 * compiled WebAssembly artifact; the ordering quirks it encodes are load-
 * bearing and are called out individually.
 */

import { kv, ipc, log, installPanicHandler } from './sdk/index.js';
import { SysError } from './sdk/error.js';
import { jsonMap, toJsonString } from './rust/json-value.js';
import { SerdeJsonError } from './rust/json-parse.js';
import {
  buildRequestFromSlice,
  identityBuilderFromSlice,
  sparkConfigFromValue,
  toolExecPayloadFromSlice,
  valueFromSlice,
} from './rust/serde.js';
import { IdentityBuilder } from './identity.js';
import { describeResponseJson } from './schema.js';

export const STATE_KEY = '__state';
export const TOOL_RESULT_TOPIC = 'tool.v1.execute.save_identity.result';

/** The capsule's `astrid:sys` `capsule-result` record. */
function deny(data) {
  return { action: 'deny', data };
}

function proceed(data = null) {
  return { action: 'continue', data };
}

/**
 * Load `__state`.
 *
 * An absent key reads back as zero bytes, which `serde_json` rejects, so the
 * macro treats *any* `JsonError` — missing key or corrupt value alike — as
 * "start from `Default::default()`". Only a genuine host failure is fatal.
 *
 * @returns {{state: IdentityBuilder}|{error: SysError}}
 */
function loadState() {
  try {
    const fields = kv.getJson(STATE_KEY, identityBuilderFromSlice);
    return { state: new IdentityBuilder(fields.spark, fields.onboarded) };
  } catch (err) {
    if (err instanceof SysError && err.variant === 'JsonError') {
      return { state: IdentityBuilder.default() };
    }
    if (err instanceof SysError) return { error: err };
    throw err;
  }
}

function saveState(instance) {
  try {
    kv.setJson(STATE_KEY, instance.serialize());
    return null;
  } catch (err) {
    if (err instanceof SysError) return err;
    throw err;
  }
}

/**
 * The shared body of `handle_build_request` and `handle_command`.
 *
 * Both wrapped methods return `()`, so the serialized result is the literal
 * `"null"` and the macro's "result is null" branch always fires — every
 * successful call answers `continue` with no data. State is written back even
 * when the call changed nothing.
 */
function runInterceptor(payload, parseArgs, invoke) {
  const loaded = loadState();
  if (loaded.error) return deny(`failed to load state: ${loaded.error.display()}`);
  const instance = loaded.state;

  try {
    let args;
    try {
      args = parseArgs(payload);
    } catch (err) {
      if (err instanceof SerdeJsonError) {
        return deny(`failed to parse arguments: ${err.display()}`);
      }
      throw err;
    }
    invoke(instance, args);
  } catch (err) {
    if (err instanceof SysError) return deny(err.display());
    throw err;
  }

  const saveError = saveState(instance);
  if (saveError) return deny(`failed to save state: ${saveError.display()}`);

  return proceed();
}

function publishToolResult(callId, content, isError) {
  const envelope = toJsonString(jsonMap({
    type: 'tool_execute_result',
    call_id: callId,
    result: jsonMap({ call_id: callId, content, is_error: isError }),
  }));
  try {
    ipc.publishJson(TOOL_RESULT_TOPIC, envelope);
  } catch (err) {
    // `let _ = ipc::publish_json(...)` — the macro discards the outcome.
    if (!(err instanceof SysError)) throw err;
  }
}

function runSaveIdentityTool(payload) {
  let toolReq;
  try {
    toolReq = toolExecPayloadFromSlice(payload);
  } catch (err) {
    if (err instanceof SerdeJsonError) {
      return deny(`failed to parse tool execute payload: ${err.display()}`);
    }
    throw err;
  }

  const callId = toolReq.call_id;

  const loaded = loadState();
  if (loaded.error) {
    publishToolResult(callId, `failed to load state: ${loaded.error.display()}`, true);
    return proceed();
  }
  const instance = loaded.state;

  let resultStr;
  let isError;
  try {
    let args;
    try {
      args = sparkConfigFromValue(toolReq.arguments);
    } catch (err) {
      if (err instanceof SerdeJsonError) {
        throw new ToolFailure(`failed to parse tool arguments: ${err.display()}`);
      }
      throw err;
    }
    resultStr = toJsonString(instance.saveIdentity(args));
    isError = false;
  } catch (err) {
    if (err instanceof ToolFailure) {
      resultStr = err.message;
    } else if (err instanceof SysError) {
      resultStr = err.display();
    } else {
      throw err;
    }
    isError = true;
  }

  // A failed tool call leaves `__state` untouched, so a rejected `save_identity`
  // cannot half-apply the new identity.
  if (!isError) {
    const saveError = saveState(instance);
    if (saveError) {
      publishToolResult(callId, `failed to save state: ${saveError.display()}`, true);
      return proceed();
    }
  }

  publishToolResult(callId, resultStr, isError);
  return proceed();
}

class ToolFailure extends Error {}

function runToolDescribe() {
  const response = describeResponseJson();
  try {
    ipc.publishJson('tool.v1.response.describe.self', response);
  } catch (err) {
    if (!(err instanceof SysError)) throw err;
    log.warn(
      `tool_describe: failed to publish descriptor, tools absent from describe fan-out: ${err.debug()}`,
    );
  }
  return proceed(response);
}

/**
 * The `astrid-hook-trigger` export.
 *
 * @param {string} action
 * @param {Uint8Array} payload
 * @returns {{action: string, data: string|null}}
 */
export function astridHookTrigger(action, payload) {
  installPanicHandler();

  switch (action) {
    case 'handle_build_request':
      return runInterceptor(payload, buildRequestFromSlice, (instance, args) =>
        instance.buildSystemPrompt(args));
    case 'handle_command':
      return runInterceptor(payload, valueFromSlice, (instance, args) =>
        instance.handleCommand(args));
    case 'tool_execute_save_identity':
      return runSaveIdentityTool(payload);
    case 'tool_describe':
      return runToolDescribe();
    default:
      return deny(`unknown hook action: ${action}`);
  }
}

/** The `run`, `astrid-install` and `astrid-upgrade` exports. */
export function run() {
  installPanicHandler();
}

export const astridInstall = run;
export const astridUpgrade = run;
