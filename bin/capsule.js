#!/usr/bin/env node
// Command-line dispatcher for the capsule's four WIT exports.
//
// Migration note: the Rust crate builds a wasm component; the Astrid
// kernel instantiates it and calls the exports directly, so upstream has
// no executable entry point. Node cannot be instantiated as a component,
// so the same four exports are reachable here as subcommands. `run`,
// `install` and `upgrade` do exactly what the Rust exports do (install
// the panic handler and return). `hook` forwards to
// `astrid-hook-trigger` with a filesystem-backed host so the capsule can
// be exercised standalone.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { astridHookTrigger, run, astridInstall, astridUpgrade } from '../src/capsule.js';
import { withHost } from '../src/sdk/host.js';
import { createLocalHost } from '../src/sdk/local-host.js';

const USAGE = `astrid-capsule-identity — identity capsule for Astrid OS

Usage:
  astrid-capsule-identity run
  astrid-capsule-identity install
  astrid-capsule-identity upgrade
  astrid-capsule-identity hook <action> [--payload <file>] [--home <dir>] [--state <file>]

Hook actions:
  handle_build_request         build the system prompt
  handle_command               run an /identity-export or /identity-import command
  tool_execute_save_identity   persist an identity chosen by the model
  tool_describe                emit the tool descriptor

The payload is read from --payload, or from stdin when that flag is
absent. --home defaults to ./.astrid-home and --state to
./.astrid-home/.kv.json.`;

/**
 * @param {string[]} argv
 * @returns {{positional: string[], flags: Record<string, string>}}
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = argv[i + 1] ?? '';
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * @param {string|undefined} file
 * @returns {Uint8Array}
 */
function readPayload(file) {
  if (file !== undefined && file !== '' && file !== '-') {
    return new Uint8Array(readFileSync(resolve(file)));
  }
  try {
    return new Uint8Array(readFileSync(0));
  } catch {
    return new Uint8Array(0);
  }
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'run';

  if (flags.help !== undefined || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  switch (command) {
    case 'run':
      run();
      return 0;
    case 'install':
      astridInstall();
      return 0;
    case 'upgrade':
      astridUpgrade();
      return 0;
    case 'hook':
      break;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }

  const action = positional[1];
  if (action === undefined) {
    process.stderr.write(`hook requires an action\n\n${USAGE}\n`);
    return 2;
  }

  const home = resolve(flags.home ?? '.astrid-home');
  const statePath = resolve(flags.state ?? `${home}/.kv.json`);
  const host = createLocalHost({ root: home, statePath });
  const payload = readPayload(flags.payload);

  const result = withHost(host, () => astridHookTrigger(action, payload));
  process.stdout.write(`${JSON.stringify({ action: result.action, data: result.data })}\n`);

  // The kernel treats `deny` as a rejected hook. Surface that as a
  // non-zero exit so shell callers can react without parsing the JSON.
  return result.action === 'deny' ? 1 : 0;
}

process.exitCode = main();
