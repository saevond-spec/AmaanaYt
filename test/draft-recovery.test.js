'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isYouTubeUploadLimitError, isDefiniteYouTubeUploadRejection,
  isRetryableYouTubeUploadRejection, isUploadRetryCoolingDown,
  canRetryTwitchDraft, isOwnedPrivateYouTubeVideo, buildUploadReconciliationPatch,
  findDueTwitchVodRetries, findDueTwitchHighlightRetryParents,
  claimDueTwitchHighlightRetryParents, recoverInterruptedYouTubeUploads,
  computeRetryDelayMs } = require('../src/draft-recovery');

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


test('separates definite YouTube rejections from ambiguous transport and server errors', () => {
  assert.equal(isDefiniteYouTubeUploadRejection({ status: 403 }), true);
  assert.equal(isDefiniteYouTubeUploadRejection({ response: { status: 400 } }), true);
  assert.equal(isDefiniteYouTubeUploadRejection({ status: 503 }), false);
  assert.equal(isDefiniteYouTubeUploadRejection(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })), false);
  assert.equal(isRetryableYouTubeUploadRejection({ status: 429 }), true);
  assert.equal(isRetryableYouTubeUploadRejection({ status: 403 }), false);
});

test('only schedules due upload-limit Shorts whose parent is safely resumable', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const parent = { id: 'parent', sourceType: 'twitch_highlight_batch',
    status: 'clip_partial', youtubeVideoId: 'abcdefghijk' };
  const due = { id: 'due', sourceType: 'twitch_highlight_short', parentId: 'parent',
    status: 'clip_retry_wait', error: 'uploadLimitExceeded: retry after daily limit', nextClipAttemptAt: '2026-10-21T11:59:00Z' };
  const candidates = [
    parent, due,
    { ...due, id: 'uncertain', status: 'clip_upload_uncertain' },
    { ...due, id: 'future', nextClipAttemptAt: '2026-10-21T12:01:00Z' },
    { ...due, id: 'wrong-error', error: 'temporary render error' },
    { ...due, id: 'bad-date', nextClipAttemptAt: 'not-a-date' },
    { ...due, id: 'missing-parent', parentId: 'nope' },
    { id: 'excluded-parent', sourceType: 'twitch_highlight_batch',
      status: 'excluded_by_owner', youtubeVideoId: 'lmnopqrstuv' },
    { ...due, id: 'excluded-child', parentId: 'excluded-parent' },
    { id: 'no-id-parent', sourceType: 'twitch_highlight_batch',
      status: 'clip_partial' },
    { ...due, id: 'no-id-child', parentId: 'no-id-parent' },
    { id: 'cooling-parent', sourceType: 'twitch_highlight_batch', status: 'clip_retry_wait',
      youtubeVideoId: 'abcdefghijk', nextClipAttemptAt: '2026-10-21T12:01:00Z' },
    { ...due, id: 'cooling-child', parentId: 'cooling-parent' },
    { id: 'leased-parent', sourceType: 'twitch_highlight_batch', status: 'clip_partial',
      youtubeVideoId: 'abcdefghijk', retryLeaseUntil: '2026-10-21T12:01:00Z' },
    { ...due, id: 'leased-child', parentId: 'leased-parent' },
    { id: 'capped-parent', sourceType: 'twitch_highlight_batch', status: 'clip_partial',
      youtubeVideoId: 'abcdefghijk', clipAttemptCount: 12 },
    { ...due, id: 'capped-child', parentId: 'capped-parent' }
  ];
  assert.deepEqual(findDueTwitchHighlightRetryParents(candidates, now).map((draft) => draft.id), ['parent']);
});

test('private-video reconciliation verifies ID, connected channel ownership, and private visibility', () => {
  const channel = { id: 'channel-1' };
  const video = { id: 'abcdefghijk', snippet: { channelId: 'channel-1' },
    status: { privacyStatus: 'private' } };
  assert.equal(isOwnedPrivateYouTubeVideo(video, channel, 'abcdefghijk'), true);
  assert.equal(isOwnedPrivateYouTubeVideo({ ...video, snippet: { channelId: 'other' } }, channel, 'abcdefghijk'), false);
  assert.equal(isOwnedPrivateYouTubeVideo({ ...video, status: { privacyStatus: 'public' } }, channel, 'abcdefghijk'), false);
  assert.equal(isOwnedPrivateYouTubeVideo(video, channel, 'lmnopqrstuv'), false);
});

test('uncertain uploads require explicit reconciliation and never attach an unverified ID', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const parent = { id: 'batch-1', sourceType: 'twitch_highlight_batch', status: 'clip_upload_uncertain' };
  assert.throws(() => buildUploadReconciliationPatch(parent, {}, now), /Provide a verified private/);
  assert.throws(() => buildUploadReconciliationPatch({ ...parent, status: 'clip_partial' },
    { confirmNoUpload: true }, now), /Only an uncertain/);
  const attached = buildUploadReconciliationPatch(parent, { youtubeVideoId: 'abcdefghijk' }, now);
  assert.equal(attached.youtubeVideoId, 'abcdefghijk');
  assert.equal(attached.status, 'creating_shorts');
  assert.equal(attached.manualReconciliationAction, 'private_video_attached');
  const confirmedAbsent = buildUploadReconciliationPatch(parent, { confirmNoUpload: true }, now);
  assert.equal(confirmedAbsent.status, 'clip_queued');
  assert.equal(confirmedAbsent.manualReconciliationAction, 'owner_confirmed_no_upload');
  assert.equal(confirmedAbsent.nextClipAttemptAt, null);
});

test('manual retry cannot bypass a future provider backoff', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(isUploadRetryCoolingDown({ status: 'clip_retry_wait',
    nextClipAttemptAt: '2026-10-21T12:01:00Z' }, now), true);
  assert.equal(isUploadRetryCoolingDown({ status: 'clip_retry_wait',
    nextClipAttemptAt: '2026-10-21T11:59:00Z' }, now), false);
});


test('cannot blindly retry uncertain uploads or bypass a future upload-limit deadline', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'clip_upload_uncertain', error: 'check YouTube' }, now), false);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_vod',
    status: 'uploading_private_to_youtube' }, now), false);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'clip_retry_wait', error: 'uploadLimitExceeded',
    nextClipAttemptAt: '2026-10-22T12:00:00Z' }, now), false);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'clip_retry_wait', error: 'uploadLimitExceeded',
    nextClipAttemptAt: '2026-10-21T11:59:00Z' }, now), true);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_vod',
    status: 'clip_failed' }, now), true);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'excluded_by_owner', error: 'old processing error' }, now), false);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'completed', error: 'stale error' }, now), false);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'clip_partial', publicationStatus: 'published' }, now), false);
  assert.equal(canRetryTwitchDraft({ sourceType: 'twitch_highlight_batch',
    status: 'clip_queued', error: 'stale error' }, now), false);
});

test('Twitch VOD retry selector enforces attempt limits and retry deadlines', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const candidates = [
    { id: 'last-attempt', sourceType: 'twitch_vod', status: 'clip_retry_wait',
      clipAttemptCount: 7, nextClipAttemptAt: '2026-10-21T11:59:00Z' },
    { id: 'capped', sourceType: 'twitch_vod', status: 'clip_retry_wait',
      clipAttemptCount: 8, nextClipAttemptAt: '2026-10-21T11:59:00Z' },
    { id: 'future', sourceType: 'twitch_vod', status: 'clip_retry_wait',
      clipAttemptCount: 1, nextClipAttemptAt: '2026-10-21T12:01:00Z' }
  ];
  assert.deepEqual(findDueTwitchVodRetries(candidates, now, 8).map((draft) => draft.id), ['last-attempt']);
});

test('retryable Short parent claims require a durable lease and defer to parent backoff', async () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const parent = { id: 'parent', sourceType: 'twitch_highlight_batch',
    status: 'clip_partial', youtubeVideoId: 'abcdefghijk' };
  const short = { id: 'short', sourceType: 'twitch_highlight_short', parentId: 'parent',
    status: 'clip_retry_wait', error: 'retry upload', uploadRejectionStatus: 429,
    nextClipAttemptAt: '2026-10-21T11:59:00Z' };
  const errors = [];
  const failedClaim = await claimDueTwitchHighlightRetryParents([parent, short],
    async () => { throw new Error('database write failed'); },
    { now, onError: (error, draft) => errors.push([error.message, draft.id]) });
  assert.deepEqual(failedClaim, []);
  assert.deepEqual(errors, [['database write failed', 'parent']]);

  let persistedParent = { ...parent };
  const claimed = await claimDueTwitchHighlightRetryParents([persistedParent, short],
    async (_id, patch) => (persistedParent = { ...persistedParent, ...patch }),
    { now, leaseMs: 60_000 });
  assert.deepEqual(claimed.map((draft) => draft.id), ['parent']);
  assert.equal(Date.parse(persistedParent.retryLeaseUntil), now + 60_000);
  assert.deepEqual(findDueTwitchHighlightRetryParents([persistedParent, short], now), []);
  assert.deepEqual(findDueTwitchHighlightRetryParents([persistedParent, short], now + 60_001)
    .map((draft) => draft.id), ['parent']);

  persistedParent = { ...persistedParent, status: 'clip_retry_wait',
    nextClipAttemptAt: '2026-10-21T12:02:00Z', retryLeaseUntil: null };
  assert.deepEqual(findDueTwitchHighlightRetryParents([persistedParent, short], now + 60_001), [],
    'the parent-level backoff prevents a Short from bypassing the retry window');
});

test('retry delay is deterministic, capped, and never shorter than provider Retry-After', () => {
  const inputs = { attempt: 4, baseDelayMs: 1000, maxDelayMs: 8000,
    minimumDelayMs: 250, seed: 'stable-job-id' };
  const first = computeRetryDelayMs(inputs);
  assert.equal(first, computeRetryDelayMs(inputs));
  assert.ok(first >= 4000 && first <= 8000);
  const capped = computeRetryDelayMs({ ...inputs, attempt: 100 });
  assert.ok(capped >= 4000 && capped <= 8000);
  assert.equal(computeRetryDelayMs({ ...inputs, providerRetryAfterMs: 12_000 }), 12_000);
});
