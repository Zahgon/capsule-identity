// Port of the `#[cfg(test)] mod tests` block in `src/lib.rs`.
//
// One test per source test, same names, same assertions, same order. The
// Rust tests call `build_prompt_text_with_spark_loader` directly so they
// never touch a host import; the JavaScript ports do the same, which is
// why no host needs to be installed here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IdentityBuilder, SparkConfig } from '../src/identity.js';

/** Matches `fn configured_identity() -> SparkConfig` in `src/lib.rs`. */
function configuredIdentity() {
  return {
    callsign: 'Lyra',
    class: 'a precise concierge agent',
    aura: 'Calm, direct, and context aware.',
    signal: 'Use short answers unless detail is needed.',
    core: 'Preserve user boundaries.',
  };
}

test('prompt_requests_onboarding_until_identity_is_saved', () => {
  const builder = IdentityBuilder.default();

  const prompt = builder.buildPromptTextWithSparkLoader('/tmp/workspace', () => null);

  assert.ok(prompt.includes('# Important: Identity Setup Required'));
  assert.ok(prompt.includes('- Current working directory: /tmp/workspace'));
  assert.ok(!prompt.includes('You are Lyra'));
});

test('saved_identity_is_used_without_repeating_onboarding', () => {
  const builder = new IdentityBuilder(configuredIdentity(), true);

  const prompt = builder.buildPromptTextWithSparkLoader('/tmp/workspace', () => null);

  assert.ok(prompt.includes('You are Lyra, a precise concierge agent.'));
  assert.ok(prompt.includes('# Personality\nCalm, direct, and context aware.'));
  assert.ok(prompt.includes('# Communication Style\nUse short answers unless detail is needed.'));
  assert.ok(prompt.includes('# Core Directives\nPreserve user boundaries.'));
  assert.ok(!prompt.includes('# Important: Identity Setup Required'));
});

test('spark_file_loader_restores_identity_when_state_is_empty', () => {
  const builder = IdentityBuilder.default();
  const spark = SparkConfig.toToml(configuredIdentity());

  const prompt = builder.buildPromptTextWithSparkLoader('/tmp/workspace', () => spark);

  assert.ok(prompt.includes('You are Lyra, a precise concierge agent.'));
  assert.ok(!prompt.includes('# Important: Identity Setup Required'));
});
