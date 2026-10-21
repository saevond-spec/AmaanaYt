'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('reads only active per-video analysis cooldowns', async (t) => {
  const originalQuery = store.pool.query;
  const queries = [];
  const retryAfter = '2026-10-22T00:00:00.000Z';
  store.pool.query = async (sql, parameters) => {
    queries.push({ sql: String(sql), parameters });
    if (/SELECT status, provider_code AS "providerCode"/.test(String(sql))) {
      return { rows: [{ status: 403, providerCode: 'PERMISSION_DENIED',
        message: 'video is unavailable', retryAfter: new Date(retryAfter) }] };
    }
    return { rows: [] };
  };
  t.after(() => { store.pool.query = originalQuery; });

  const failure = await store.getVideoAnalysisFailure('video-1');

  assert.equal(failure.status, 403);
  assert.equal(failure.providerCode, 'PERMISSION_DENIED');
  assert.equal(failure.retryAfter, retryAfter);
  assert.match(queries.at(-1).sql, /retry_after > NOW()/);
  assert.deepEqual(queries.at(-1).parameters, ['video-1']);
});

test('stale owner-excluded drafts cannot be restored by a retry transition', async (t) => {
  const originalConnect = store.pool.connect;
  const originalQuery = store.pool.query;
  let current = {
    id: 'draft-1', sourceType: 'twitch_vod', status: 'excluded_by_owner',
    productionState: 'excluded', publicationStatus: 'excluded',
    excludedAt: '2026-10-21T18:00:01.000Z', updatedAt: '2026-10-21T18:00:01.000Z'
  };
  const calls = [];
  store.pool.query = async () => ({ rows: [] });
  store.pool.connect = async () => ({
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (/SELECT payload FROM amaana_drafts WHERE id = \$1 FOR UPDATE/.test(String(sql))) {
        return { rows: [{ payload: { ...current } }] };
      }
      if (/UPDATE amaana_drafts SET payload = \$2::jsonb/.test(String(sql))) {
        current = JSON.parse(parameters[1]);
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => {
    store.pool.connect = originalConnect;
    store.pool.query = originalQuery;
  });

  const updated = await store.updateDraftIfUnchanged('draft-1', {
    id: 'draft-1', sourceType: 'twitch_vod', status: 'clip_failed',
    updatedAt: '2026-10-21T17:59:59.000Z'
  }, { status: 'clip_queued', productionState: 'queued' });

  assert.equal(updated, null);
  assert.equal(current.status, 'excluded_by_owner');
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(calls.some((call) => call.sql.startsWith('UPDATE amaana_drafts')), false);

  const rejectedGenericUpdate = await store.updateDraft('draft-1', { status: 'clip_queued' });
  assert.equal(rejectedGenericUpdate, null);
  assert.equal(current.status, 'excluded_by_owner');

  current = {
    id: 'draft-1', sourceType: 'twitch_vod', status: 'clip_upload_uncertain',
    productionState: 'manual_reconciliation', updatedAt: '2026-10-21T18:01:00.000Z'
  };
  const attached = await store.updateDraftIfUnchanged('draft-1', { ...current }, {
    status: 'awaiting_owner_approval', productionState: 'ready', youtubeVideoId: 'abcdefghijk'
  });
  assert.equal(attached.status, 'awaiting_owner_approval');
  assert.equal(attached.youtubeVideoId, 'abcdefghijk');
  assert.equal(current.status, 'awaiting_owner_approval');
});
test('lease-fenced draft updates reject a worker whose claim has been replaced', async (t) => {
  const originalConnect = store.pool.connect;
  const originalQuery = store.pool.query;
  let current = {
    id: 'draft-1', sourceType: 'twitch_vod', status: 'clip_retry_wait',
    retryLeaseClaimToken: 'new-owner', retryLeaseUntil: new Date(Date.now() + 60000).toISOString(),
    updatedAt: new Date().toISOString()
  };
  const calls = [];
  store.pool.query = async () => ({ rows: [] });
  store.pool.connect = async () => ({
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (/SELECT payload FROM amaana_drafts WHERE id = \$1 FOR UPDATE/.test(String(sql))) {
        return { rows: [{ payload: { ...current } }] };
      }
      if (/UPDATE amaana_drafts SET payload = \$2::jsonb/.test(String(sql))) {
        current = JSON.parse(parameters[1]);
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { store.pool.connect = originalConnect; store.pool.query = originalQuery; });

  const stale = await store.updateDraftWithRetryLease('draft-1', 'old-owner', { status: 'clip_failed' });
  assert.equal(stale, null);
  assert.equal(current.status, 'clip_retry_wait');
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));

  const currentOwner = await store.updateDraftWithRetryLease('draft-1', 'new-owner', {
    status: 'waiting_for_clip_media', twitchClipId: 'clip-1'
  });
  assert.equal(currentOwner.status, 'waiting_for_clip_media');
  assert.equal(current.twitchClipId, 'clip-1');
});

test('group exclusion locks VOD parents and discovers children before updating', async (t) => {
  const originalConnect = store.pool.connect;
  const originalQuery = store.pool.query;
  const rootId = '11111111-1111-4111-8111-111111111111';
  const batchId = '22222222-2222-4222-8222-222222222222';
  const shortId = '33333333-3333-4333-8333-333333333333';
  const drafts = new Map([
    [rootId, { id: rootId, sourceType: 'twitch_vod', vodId: '1234567890', status: 'clip_failed' }],
    [batchId, { id: batchId, sourceType: 'twitch_highlight_batch', vodId: '1234567890', status: 'creating_shorts' }],
    [shortId, { id: shortId, sourceType: 'twitch_highlight_short', vodId: '1234567890',
      parentId: batchId, status: 'uploading_private_to_youtube' }]
  ]);
  const calls = [];
  store.pool.query = async () => ({ rows: [] });
  store.pool.connect = async () => ({
    async query(sql, parameters) {
      const text = String(sql);
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (/SELECT id, payload FROM amaana_drafts WHERE id = \$1 FOR UPDATE/.test(text)) {
        const row = drafts.get(String(parameters[0]));
        return { rows: row ? [{ id: row.id, payload: { ...row } }] : [] };
      }
      if (/SELECT id FROM amaana_drafts WHERE payload->>'sourceType'/.test(text)) {
        return { rows: [{ id: batchId }] };
      }
      if (/SELECT id FROM amaana_drafts WHERE payload->>'parentId'/.test(text)) {
        assert.deepEqual(parameters[0], [rootId, batchId]);
        return { rows: [{ id: shortId }] };
      }
      if (/SELECT id, payload FROM amaana_drafts WHERE id = ANY/.test(text)) {
        return { rows: parameters[0].map((id) => drafts.get(id)).filter(Boolean)
          .map((row) => ({ id: row.id, payload: { ...row } })) };
      }
      if (/UPDATE amaana_drafts SET payload = \$2::jsonb/.test(text)) {
        const updated = JSON.parse(parameters[1]);
        drafts.set(String(parameters[0]), updated);
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { store.pool.connect = originalConnect; store.pool.query = originalQuery; });

  await assert.rejects(store.excludeDrafts([rootId, batchId], 'test', rootId), (error) => error.status === 409);
  const parentLock = calls.findIndex((sql) => /payload->>'sourceType'/.test(sql));
  const childrenLock = calls.findIndex((sql) => /payload->>'parentId'/.test(sql));
  assert.ok(parentLock >= 0 && childrenLock > parentLock);
  assert.equal(drafts.get(rootId).status, 'clip_failed');
  assert.equal(drafts.get(batchId).status, 'creating_shorts');

  drafts.set(shortId, { ...drafts.get(shortId), status: 'clip_queued' });
  const excluded = await store.excludeDrafts([rootId, batchId], 'test', rootId);
  assert.equal(excluded.length, 3);
  assert.equal(drafts.get(shortId).status, 'excluded_by_owner');
});

test('Twitch VOD retry claims serialize competing workers with one lease token', async (t) => {
  const originalConnect = store.pool.connect;
  const originalQuery = store.pool.query;
  let current = {
    id: 'vod-1', sourceType: 'twitch_vod', status: 'clip_retry_wait',
    clipAttemptCount: 2, nextClipAttemptAt: '2026-10-21T17:59:00.000Z',
    updatedAt: '2026-10-21T17:58:00.000Z'
  };
  const calls = [];
  let writes = 0;
  store.pool.query = async () => ({ rows: [] });
  store.pool.connect = async () => ({
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (/SELECT payload FROM amaana_drafts WHERE id = \$1 FOR UPDATE/.test(String(sql))) {
        return { rows: [{ payload: { ...current } }] };
      }
      if (/UPDATE amaana_drafts SET payload = \$2::jsonb/.test(String(sql))) {
        current = JSON.parse(parameters[1]);
        writes += 1;
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => {
    store.pool.connect = originalConnect;
    store.pool.query = originalQuery;
  });

  const now = Date.parse('2026-10-21T18:00:00.000Z');
  const winner = await store.claimTwitchVodDraft('vod-1', { now });
  const competingClaim = await store.claimTwitchVodDraft('vod-1', { now });

  assert.equal(winner.retryLeaseClaimToken, current.retryLeaseClaimToken);
  assert.ok(winner.retryLeaseClaimToken);
  assert.equal(competingClaim, null);
  assert.equal(writes, 1);
  assert.equal(calls.filter((call) =>
    /SELECT payload FROM amaana_drafts WHERE id = \$1 FOR UPDATE/.test(call.sql)).length, 2);
});
