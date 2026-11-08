const test = require('node:test');
const assert = require('node:assert/strict');
const { planScreenCaptureShort } = require('../src/live-screen-capture');

test('plans a private Short around a detected event across rolling screen segments', () => {
  const plan = planScreenCaptureShort([
    { startSeconds: 0, endSeconds: 16 },
    { startSeconds: 15, endSeconds: 31 },
    { startSeconds: 30, endSeconds: 46 }
  ], [16, 16, 16], 29.5);

  assert.equal(plan.firstIndex, 1);
  assert.equal(plan.lastIndex, 2);
  assert.equal(plan.markerInCombinedSeconds, 14.5);
  assert.equal(plan.clipStartSeconds, 4.5);
  assert.equal(plan.durationSeconds, 27.5);
});

test('keeps early markers within available captured footage', () => {
  const plan = planScreenCaptureShort([
    { startSeconds: 0, endSeconds: 16 },
    { startSeconds: 15, endSeconds: 31 }
  ], [16, 16], 3);

  assert.equal(plan.firstIndex, 0);
  assert.equal(plan.markerInCombinedSeconds, 3);
  assert.equal(plan.clipStartSeconds, 0);
  assert.equal(plan.durationSeconds, 30);
});

test('rejects a marker outside the supplied capture and overlong segment batches', () => {
  assert.throws(() => planScreenCaptureShort([
    { startSeconds: 0, endSeconds: 16 }
  ], [16], 20), /outside the captured screen segments/);
  assert.throws(() => planScreenCaptureShort(Array.from({ length: 5 }, (_, index) => ({
    startSeconds: index * 15, endSeconds: index * 15 + 16
  })), [16, 16, 16, 16, 16], 30), /one to four/);
});

test('rejects clips shorter than the YouTube Short minimum', () => {
  assert.throws(() => planScreenCaptureShort([
    { startSeconds: 0, endSeconds: 16 }
  ], [5], 15), /does not contain enough footage/);
});
