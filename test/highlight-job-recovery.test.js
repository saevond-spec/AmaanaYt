'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resumableTwitchClipDrafts, resumableHighlightBatchDrafts } = require('../src/highlight-job-recovery');

test('startup recovery requeues resumable Twitch clips but waits for scheduled retries', () => {
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  const statuses = [
    'clip_queued', 'creating_twitch_clip', 'waiting_for_clip_media',
    'downloading_twitch_clip', 'formatting_vertical_short', 'uploading_private_to_youtube'
  ];
  const drafts = statuses.map((status, index) => ({ id: 'clip-' + index, sourceType: 'twitch_vod', status }));
  drafts.push(
    { id: 'retry-due', sourceType: 'twitch_vod', status: 'clip_retry_wait',
      nextClipAttemptAt: new Date(now - 1).toISOString() },
    { id: 'retry-later', sourceType: 'twitch_vod', status: 'clip_retry_wait',
      nextClipAttemptAt: new Date(now + 1).toISOString() },
    { id: 'retry-invalid', sourceType: 'twitch_vod', status: 'clip_retry_wait', nextClipAttemptAt: 'bad-date' },
    { id: 'wrong-source', sourceType: 'twitch_highlight_batch', status: 'clip_queued' },
    { id: 'completed', sourceType: 'twitch_vod', status: 'completed' }
  );

  assert.deepEqual(resumableTwitchClipDrafts(drafts, now).map((draft) => draft.id),
    [...statuses.map((_, index) => 'clip-' + index), 'retry-due']);
  assert.deepEqual(resumableTwitchClipDrafts(null, now), []);
});

test('startup recovery requeues in-progress highlight batches and leaves review states alone', () => {
  const statuses = ['clip_queued', 'creating_twitch_clips', 'assembling_highlight_video', 'creating_shorts',
    'uploading_private_to_youtube'];
  const drafts = statuses.map((status, index) => ({
    id: 'batch-' + index, sourceType: 'twitch_highlight_batch', status
  }));
  drafts.push(
    { id: 'review', sourceType: 'twitch_highlight_batch', status: 'awaiting_owner_approval' },
    { id: 'completed', sourceType: 'twitch_highlight_batch', status: 'completed' },
    { id: 'wrong-source', sourceType: 'twitch_vod', status: 'creating_shorts' }
  );

  assert.deepEqual(resumableHighlightBatchDrafts(drafts).map((draft) => draft.id),
    statuses.map((_, index) => 'batch-' + index));
  assert.deepEqual(resumableHighlightBatchDrafts(null), []);
});
