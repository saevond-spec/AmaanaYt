'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isYouTubeUploadLimitError, recoverInterruptedYouTubeUploads } = require('../src/draft-recovery');

test('identifies a definite YouTube channel upload-limit rejection', () => {
  assert.equal(isYouTubeUploadLimitError({
    response: { data: { error: { code: 400, errors: [{ reason: 'uploadLimitExceeded' }] } } }
  }), true);
  assert.equal(isYouTubeUploadLimitError(new Error('network socket closed')), false);
});

test('recovers interrupted private uploads without retrying ambiguous ones', async () => {
  const drafts = [
    { id: 'ambiguous', sourceType: 'twitch_vod', status: 'uploading_private_to_youtube' },
    { id: 'saved', sourceType: 'twitch_vod', status: 'uploading_private_to_youtube', youtubeVideoId: 'yt-1' },
    { id: 'other', sourceType: 'twitch_highlight_batch', status: 'uploading_private_to_youtube' },
    { id: 'queued', sourceType: 'twitch_vod', status: 'clip_queued' }
  ];
  const updates = [];
  const recovered = await recoverInterruptedYouTubeUploads(drafts, async (id, patch) => {
    updates.push({ id, patch });
    return { ...drafts.find((draft) => draft.id === id), ...patch };
  });

  assert.deepEqual(updates.map(({ id }) => id), ['ambiguous', 'saved']);
  assert.equal(recovered[0].status, 'clip_upload_uncertain');
  assert.equal(recovered[0].productionState, 'manual_reconciliation');
  assert.match(recovered[0].error, /check the channel for a private upload before retrying/i);
  assert.equal(recovered[1].status, 'awaiting_owner_approval');
  assert.equal(recovered[1].youtubeVideoId, 'yt-1');
  assert.equal(recovered[2], drafts[2]);
  assert.equal(recovered[3], drafts[3]);
});
