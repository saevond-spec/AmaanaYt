'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHttpError } = require('../src/http-error-response');

test('hides internal server messages from clients while returning a correlation ID', () => {
  const result = normalizeHttpError(new Error('database password rejected'), 'req-123');
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Unexpected server error', requestId: 'req-123' });
  assert.match(result.log.message, /database password rejected/);
});

test('preserves safe client validation messages and clamps invalid status values', () => {
  assert.deepEqual(normalizeHttpError(Object.assign(new Error('Draft not found'), { status: 404 }), 'req-2').body,
    { error: 'Draft not found', requestId: 'req-2' });
  assert.equal(normalizeHttpError(Object.assign(new Error('bad'), { status: 700 }), 'req-3').status, 500);
});
