'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTwitchDuration, validateHighlightMoments, verifyCreatedClip,
  verifyClipCreationRequest, hasVerifiedGameplayHighlight, hasVerifiedLiveGameplayClip,
  VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS } = require('../src/highlight-validation');

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

test('deduplicates overlaps while allowing up to twenty selected moments', () => {
  const items = [
    { startSeconds: 0, endSeconds: 30, title: 'lower overlap', score: 70 },
    { startSeconds: 5, endSeconds: 35, title: 'higher overlap', score: 90 },
    { startSeconds: 60, endSeconds: 90, title: 'third moment', score: 80 },
    ...Array.from({ length: 17 }, (_, index) => ({
      startSeconds: 120 + index * 40,
      endSeconds: 150 + index * 40,
      title: 'Moment ' + index,
      score: 60 + index
    }))
  ];
  const result = validateHighlightMoments(items, 1000);
  assert.equal(result.length, 19);
  assert.deepEqual(result.map((item) => item.startSeconds), [5, 60, ...Array.from({ length: 17 }, (_, index) => 120 + index * 40)]);
  assert.equal(result[0].title, 'higher overlap');
  assert.throws(() => validateHighlightMoments([...items, {
    startSeconds: 900, endSeconds: 930, title: 'Too many', score: 50
  }], 1000), /more than 20/);
});

test('verifies the VOD source and moment in Amaana accepted clip requests', () => {
  assert.deepEqual(verifyClipCreationRequest({ startSeconds: 30, duration: 30 }, {
    id: 'created-clip', requestedVodId: '123', requestedVodOffset: 60, requestedDuration: 30
  }, '123'), {
    sourceVodId: '123', startSeconds: 30, endSeconds: 60, duration: 30,
    verified: true, verificationMethod: 'twitch_vod_clip_request'
  });

  assert.throws(() => verifyClipCreationRequest({ startSeconds: 30, duration: 30 }, {
    id: 'created-clip', requestedVodId: '999', requestedVodOffset: 60, requestedDuration: 30
  }, '123'), { status: 409, code: 'TWITCH_CLIP_WRONG_VOD' });
  assert.throws(() => verifyClipCreationRequest({ startSeconds: 30, duration: 30 }, {
    id: 'created-clip', requestedVodId: '123', requestedVodOffset: 80, requestedDuration: 30
  }, '123'), { status: 422, code: 'TWITCH_CLIP_REQUEST_MISMATCH' });
});

test('checks that each created Twitch clip points back to the requested VOD moment', () => {
  assert.deepEqual(verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '123', vod_offset: 31, duration: 30 }, '123'),
  { startSeconds: 31, endSeconds: 61, duration: 30, verified: true });

  assert.throws(() => verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '999', vod_offset: 30, duration: 30 }, '123'), {
    status: 409, code: 'TWITCH_CLIP_WRONG_VOD'
  });
  assert.throws(() => verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '', vod_offset: null, duration: 30 }, '123'), {
    status: 425, code: 'TWITCH_CLIP_METADATA_PENDING'
  });
  assert.throws(() => verifyCreatedClip({ startSeconds: 30, duration: 30 },
    { video_id: '123', vod_offset: 36, duration: 30 }, '123'), { status: 422 });
});

test('only an exact 15-minute render with complete visual gameplay checks qualifies for publishing', () => {
  const valid = {
    sourceType: 'twitch_highlight_batch',
    targetHighlightDurationSeconds: VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS,
    duration: 900,
    mediaValidation: 'passed',
    highlights: [{ duration: 60 }],
    twitchClips: [{ visualGameplayVerification: {
      verified: true, totalFrames: 5, activeGameplayFrames: 4, confidence: 0.8
    } }]
  };
  assert.equal(hasVerifiedGameplayHighlight(valid), true);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, duration: 119.6 }), false);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, duration: undefined }), false);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, targetHighlightDurationSeconds: 899 }), false);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, mediaValidation: 'failed' }), false);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, twitchClips: [] }), false);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, twitchClips: [{ visualGameplayVerification: {
    verified: true, totalFrames: 5, activeGameplayFrames: 3, confidence: 0.95
  } }] }), false);
  assert.equal(hasVerifiedGameplayHighlight({ ...valid, twitchClips: [{ visualGameplayVerification: {
    verified: true, totalFrames: 5, activeGameplayFrames: 4, confidence: 0.79
  } }] }), false);
});

test('live-captured Shorts require strong gameplay verification evidence', () => {
  const valid = {
    sourceType: 'twitch_vod',
    discoverySource: 'twitch_live_capture',
    liveCapture: true,
    visualGameplayVerification: {
      verified: true, totalFrames: 5, activeGameplayFrames: 4, confidence: 0.8
    }
  };
  assert.equal(hasVerifiedLiveGameplayClip(valid), true);
  assert.equal(hasVerifiedLiveGameplayClip({ ...valid, liveCapture: false }), false);
  assert.equal(hasVerifiedLiveGameplayClip({ ...valid, visualGameplayVerification: {
    ...valid.visualGameplayVerification, activeGameplayFrames: 3
  } }), false);
  assert.equal(hasVerifiedLiveGameplayClip({ ...valid, visualGameplayVerification: {
    ...valid.visualGameplayVerification, confidence: 0.79
  } }), false);
});

