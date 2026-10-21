'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createModelCircuitBreaker, geminiRetryAfterMs, isGeminiDailyQuotaError,
  nextPacificMidnight } = require('../src/seo-package');
const { geminiQuotaIsShared } = require('../src/seo-worker');

test('Gemini distinguishes daily quota exhaustion from temporary rate limiting', () => {
  assert.equal(isGeminiDailyQuotaError({ providerReason: 'QUOTA_EXCEEDED' }), true);
  assert.equal(isGeminiDailyQuotaError({ code: 'rate_limit_exceeded' }), false);
  assert.equal(isGeminiDailyQuotaError({ providerMessage: 'Daily quota exceeded' }), true);
});

test('daily Gemini quota cooldown reaches the next Pacific midnight across DST', () => {
  const timestamp = Date.parse('2026-03-08T07:30:00.000Z');
  const expectedReset = Date.parse('2026-03-08T08:00:00.000Z');
  assert.equal(nextPacificMidnight(timestamp), expectedReset);
  assert.equal(geminiRetryAfterMs({ providerReason: 'QUOTA_EXCEEDED',
    retryAfterPresent: true, retryAfterMs: 60_000 }, timestamp), expectedReset - timestamp);
});

test('Gemini model breaker honors provider Retry-After', () => {
  let now = 1_000_000;
  const breaker = createModelCircuitBreaker({ now: () => now });
  breaker.record('gemini-test', 429, 3_600_000);
  assert.equal(breaker.remaining('gemini-test'), 3_600_000);
  now += 3_600_001;
  assert.equal(breaker.remaining('gemini-test'), 0);
});

test('different Gemini keys share quota unless deployment config proves projects differ', () => {
  const common = { SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    SEO_AI_API_KEY: 'seo-key', VIDEO_ANALYSIS_API_KEY: 'analysis-key' };
  assert.equal(geminiQuotaIsShared(common), true);
  assert.equal(geminiQuotaIsShared({ ...common, SEO_AI_PROJECT_ID: 'seo-project',
    VIDEO_ANALYSIS_PROJECT_ID: 'analysis-project' }), false);
  assert.equal(geminiQuotaIsShared({ ...common, VIDEO_ANALYSIS_API_KEY: 'seo-key',
    SEO_AI_PROJECT_ID: 'same-project', VIDEO_ANALYSIS_PROJECT_ID: 'same-project' }), true);
  assert.equal(geminiQuotaIsShared({ SEO_AI_API_KEY: 'seo-key' }), false);
});
