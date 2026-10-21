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
