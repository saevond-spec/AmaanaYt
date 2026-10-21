'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isYouTubeUploadLimitError, findDueTwitchVodRetries,
  recoverInterruptedYouTubeUploads } = require('../src/draft-recovery');

test('identifies a definite YouTube channel upload-limit rejection', () => {
  assert.equal(isYouTubeUploadLimitError({
    response: { data: { error: { code: 400, errors: [{ reason: 'uploadLimitExceeded' }] } } }
  }), true);
  assert.equal(isYouTubeUploadLimitError(new Error('network socket closed')), false);
});

test('continues recovery for other drafts when one recovery write fails', async () => {
  const drafts = [
    { id: 'broken-write', sourceType: 'twitch_vod', status: 'uploading_private_to_youtube' },
    { id: 'next', sourceType: 'twitch_vod', status: 'uploading_private_to_youtube' }
  ];
  const errors = [];
  const recovered = await recoverInterruptedYouTubeUploads(drafts, async (id) => {
    if (id === 'broken-write') throw new Error('temporary database error');
    return { ...drafts[1], status: 'clip_upload_uncertain' };
  }, (error, draft) => errors.push([draft.id, error.message]));

  assert.deepEqual(errors, [['broken-write', 'temporary database error']]);
  assert.equal(recovered[0].status, 'clip_upload_uncertain');
  assert.equal(recovered[1].status, 'clip_upload_uncertain');
  assert.equal(recovered[0].productionState, 'manual_reconciliation');
});

test('recovers interrupted private uploads without retrying ambiguous ones', async () => {
  const drafts = [
    { id: 'ambiguous', sourceType: 'twitch_vod', status: 'uploading_private_to_youtube' },
    { id: 'saved', sourceType: 'twitch_vod', status: 'uploading_private_to_youtube', youtubeVideoId: 'yt-1' },
    { id: 'batch-ambiguous', sourceType: 'twitch_highlight_batch', status: 'uploading_private_to_youtube' },
    { id: 'short-ambiguous', sourceType: 'twitch_highlight_short', status: 'uploading_private_to_youtube', parentId: 'batch-1', highlightIndex: 2 },
    { id: 'batch-saved', sourceType: 'twitch_highlight_batch', status: 'uploading_private_to_youtube', youtubeVideoId: 'yt-batch' },
    { id: 'short-saved', sourceType: 'twitch_highlight_short', status: 'uploading_private_to_youtube', youtubeVideoId: 'yt-short' },
    { id: 'queued', sourceType: 'twitch_vod', status: 'clip_queued' }
  ];
  const updates = [];
  const recovered = await recoverInterruptedYouTubeUploads(drafts, async (id, patch) => {
    updates.push({ id, patch });
    return { ...drafts.find((draft) => draft.id === id), ...patch };
  });

  assert.deepEqual(updates.map(({ id }) => id),
    ['ambiguous', 'saved', 'batch-ambiguous', 'short-ambiguous', 'batch-saved', 'short-saved']);
  assert.equal(recovered[0].status, 'clip_upload_uncertain');
  assert.equal(recovered[0].productionState, 'manual_reconciliation');
  assert.match(recovered[0].error, /check the channel for a private upload before retrying/i);
  assert.equal(recovered[1].status, 'awaiting_owner_approval');
  assert.equal(recovered[1].youtubeVideoId, 'yt-1');
  assert.equal(recovered[2].status, 'clip_upload_uncertain');
  assert.equal(recovered[2].productionState, 'manual_reconciliation');
  assert.equal(recovered[3].status, 'clip_upload_uncertain');
  assert.equal(recovered[3].productionState, 'manual_reconciliation');
  assert.equal(recovered[4].youtubeVideoId, 'yt-batch');
  assert.equal(recovered[4].status, 'creating_shorts');
  assert.equal(recovered[5].youtubeVideoId, 'yt-short');
  assert.equal(recovered[5].status, 'clip_partial');
  assert.equal(recovered[6], drafts[6]);
});

test('finds due VOD retry jobs across community and live-capture sources', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const due = findDueTwitchVodRetries([
    { id: 'community', sourceType: 'twitch_vod', discoverySource: 'twitch_community_clip',
      status: 'clip_retry_wait', nextClipAttemptAt: '2026-10-21T11:00:00Z' },
    { id: 'live-capture', sourceType: 'twitch_vod', discoverySource: 'twitch_live_capture',
      status: 'clip_retry_wait', nextClipAttemptAt: '2026-10-21T11:30:00Z' },
    { id: 'future', sourceType: 'twitch_vod', discoverySource: 'twitch_live_capture',
      status: 'clip_retry_wait', nextClipAttemptAt: '2026-10-21T13:00:00Z' },
    { id: 'bad-date', sourceType: 'twitch_vod', status: 'clip_retry_wait', nextClipAttemptAt: 'bad' },
    { id: 'batch', sourceType: 'twitch_highlight_batch', status: 'clip_retry_wait',
      nextClipAttemptAt: '2026-10-21T11:00:00Z' }
  ], now);
  assert.deepEqual(due.map((draft) => draft.id), ['community', 'live-capture']);
});
