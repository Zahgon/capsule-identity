/**
 * Public surface and command line tests.
 *
 * The Rust crate is a `cdylib` with no executable entry point, so there is no
 * source-side CLI to port one-for-one. These tests pin the two seams the port
 * adds in its place: the module re-export surface of `src/index.js`, and the
 * subcommand dispatcher in `bin/capsule.js` that exposes the four WIT exports
 * to a shell. Driving the binary as a child process also exercises the
 * filesystem-backed host, which the in-memory differential harness never uses.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as capsule from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'bin', 'capsule.js');

function runCli(args, { payload = null, home } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: payload ?? '',
    encoding: 'utf8',
    env: { ...process.env, HOME: home ?? process.env.HOME },
  });
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'capsule-cli-'));
}

test('index exposes the capsule entry points and the ported public types', () => {
  for (const name of ['astridHookTrigger', 'run', 'astridInstall', 'astridUpgrade']) {
    assert.equal(typeof capsule[name], 'function', `missing export ${name}`);
  }
  for (const name of ['IdentityBuilder', 'SparkConfig', 'describeResponseJson', 'SysError', 'withHost']) {
    assert.ok(capsule[name], `missing export ${name}`);
  }
  assert.equal(capsule.SPARK_CONFIG_PATH, 'home://.config/spark.toml');
  assert.equal(capsule.STATE_KEY, '__state');
  assert.equal(capsule.TOOL_RESULT_TOPIC, 'tool.v1.execute.save_identity.result');
  assert.match(capsule.ONBOARDING_PROMPT, /^# Important: Identity Setup Required/);
});

test('lifecycle subcommands succeed', () => {
  for (const command of ['run', 'install', 'upgrade']) {
    const out = runCli([command]);
    assert.equal(out.status, 0, `${command} exited ${out.status}: ${out.stderr}`);
  }
});

test('help prints usage and exits zero', () => {
  const out = runCli(['help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /astrid-capsule-identity/);
  assert.match(out.stdout, /handle_build_request/);
});

test('an unknown command exits two', () => {
  const out = runCli(['frobnicate']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /unknown command: frobnicate/);
});

test('hook without an action exits two', () => {
  const out = runCli(['hook']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /hook requires an action/);
});

test('a build request publishes the onboarding prompt', () => {
  const home = tempHome();
  const out = runCli(['hook', 'handle_build_request', '--home', home], {
    payload: '{"workspace_root":"/tmp/ws/","session_id":"s1"}',
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\{"action":"continue","data":null\}/);
  assert.match(out.stdout, /spark\.v1\.response\.ready/);
  // The trailing slash is stripped and the first-boot branch is taken.
  assert.match(out.stdout, /- Current working directory: \/tmp\/ws\\n/);
  assert.match(out.stdout, /# Important: Identity Setup Required/);
});

test('an unknown hook action is denied with a non-zero exit', () => {
  const home = tempHome();
  const out = runCli(['hook', 'bogus_action', '--home', home], { payload: '{}' });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /"action":"deny"/);
  assert.match(out.stdout, /unknown hook action: bogus_action/);
});

test('the describe hook returns the tool descriptor', () => {
  const home = tempHome();
  const out = runCli(['hook', 'tool_describe', '--home', home], { payload: '{}' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /save_identity/);
  assert.match(out.stdout, /tool\.v1\.response\.describe\.self/);
});

test('saving an identity writes spark.toml under the mounted home', () => {
  const home = tempHome();
  const payload = JSON.stringify({
    call_id: 'c1',
    tool_name: 'save_identity',
    arguments: { callsign: 'Lyra', class: 'a precise concierge agent' },
  });
  const out = runCli(['hook', 'tool_execute_save_identity', '--home', home], { payload });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"callsign\\":\\"Lyra/);

  const written = readFileSync(join(home, '.config', 'spark.toml'), 'utf8');
  assert.equal(
    written,
    'callsign = "Lyra"\nclass = "a precise concierge agent"\naura = ""\nsignal = ""\ncore = ""\n',
  );

  // State persists across processes, so the next build request skips onboarding.
  const next = runCli(['hook', 'handle_build_request', '--home', home], {
    payload: '{"workspace_root":"/w"}',
  });
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /You are Lyra, a precise concierge agent\./);
  assert.doesNotMatch(next.stdout, /# Important: Identity Setup Required/);
});

test('the identity-export command writes the configured identity', () => {
  const home = tempHome();
  const out = runCli(['hook', 'handle_command', '--home', home], {
    payload: '{"text":"identity-export","session_id":"s2"}',
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /agent\.v1\.response/);
  assert.match(out.stdout, /Identity exported to home:\/\/\.config\/spark\.toml \(88 bytes\)/);
  assert.ok(existsSync(join(home, '.config', 'spark.toml')));
});
