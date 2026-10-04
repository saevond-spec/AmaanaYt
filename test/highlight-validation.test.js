'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTwitchDuration, validateHighlightMoments, verifyCreatedClip } = require('../src/highlight-validation');

test('parses Twitch archive duration strings', () => {
  assert.equal(parseTwitchDuration('6h26m14s'), 23174);
  assert.equal(parseTwitchDuration('45m'), 2700);
  assert.equal(parseTwitchDuration('59s'), 59);
  assert.throws(() => parseTwitchDuration('duration unknown'), /invalid VOD duration/);
  assert.throws(() => parseTwitchDuration('0s'), /invalid VOD duration/);
});

test('accepts precise moments and rejects out-of-range or incomplete timestamps', () => {
  const valid = validateHighlightMoments([
    { startSeconds: 20.2, endSeconds: 50.2, title: 'Clean finish', score: 95 }
  ], 3600);
  assert.equal(valid[0].duration, 30);
  assert.equal(valid[0].startSeconds, 20.2);
  assert.equal(valid[0].score, 95);

  for (const moment of [
    { startSeconds: -1, endSeconds: 10 },
    { startSeconds: 0, endSeconds: 4.99 },
    { startSeconds: 0, endSeconds: 61 },
    { startSeconds: 3590, endSeconds: 3601 },
    { startSeconds: 20, title: 'Missing end' }
  ]) {
    assert.throws(() => validateHighlightMoments([moment], 3600));
  }
  assert.throws(() => validateHighlightMoments([{ startSeconds: 0, endSeconds: 30, score: 101 }], 3600),
    /confidence score/);
});

test('deduplicates overlapping detections by confidence and caps the list at eight', () => {
  const items = [
    { startSeconds: 0, endSeconds: 30, title: 'lower overlap', score: 70 },
    { startSeconds: 5, endSeconds: 35, title: 'higher overlap', score: 90 },
    { startSeconds: 60, endSeconds: 90, title: 'third moment', score: 80 },
    ...Array.from({ length: 7 }, (_, index) => ({
      startSeconds: 120 + index * 40,
      endSeconds: 150 + index * 40,
      title: 'Moment ' + index,
      score: 60 + index
    }))
  ];
  const result = validateHighlightMoments(items, 1000);
  assert.equal(result.length, 8);
  assert.deepEqual(result.map((item) => item.startSeconds), [5, 60, 160, 200, 240, 280, 320, 360]);
  assert.equal(result[0].title, 'higher overlap');
});

test('checks that each created Twitch clip points back to the requested VOD moment', () => {
  assert.deepEqual(verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '123', vod_offset: 31, duration: 30 }, '123'),
  { startSeconds: 31, endSeconds: 61, duration: 30, verified: true });

  assert.throws(() => verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '999', vod_offset: 30, duration: 30 }, '123'), { status: 425 });
  assert.throws(() => verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '123', vod_offset: 36, duration: 30 }, '123'), { status: 422 });
});
