const test = require('node:test');
const assert = require('node:assert/strict');
const { viewSnapshot, createShortViewMonitor } = require('../src/short-views');

function video(id, views, privacyStatus = 'public') {
  return { id, statistics: { viewCount: String(views) }, status: { privacyStatus } };
}

function fakeStore(drafts) {
  const records = new Map(drafts.map((draft) => [draft.id, { ...draft }]));
  return {
    records,
    getDraft: async (id) => records.get(id),
    listDrafts: async () => [...records.values()],
    updateDraft: async (id, patch) => {
      const updated = { ...records.get(id), ...patch };
      records.set(id, updated);
      return updated;
    }
  };
}

test('only a public YouTube Short with strictly more than 2,000 verified views qualifies', () => {
  assert.equal(viewSnapshot(video('a', 2000)).tiktokEligible, false);
  assert.equal(viewSnapshot(video('a', 2001)).tiktokEligible, true);
  assert.equal(viewSnapshot(video('a', 2500, 'private')).tiktokEligible, false);
  assert.equal(viewSnapshot(video('a', 2500, 'unlisted')).tiktokEligible, false);
  assert.equal(viewSnapshot({ id: 'a', statistics: {}, status: { privacyStatus: 'public' } }).tiktokEligible, false);
  assert.equal(viewSnapshot(undefined).tiktokEligible, false);
});

test('view refresh sends only opted-in stream Shorts to automatic delivery, once', async () => {
  const store = fakeStore([
    { id: 'a', sourceType: 'twitch_highlight_short', youtubeVideoId: 'yt-a', tiktokAutoSendConsent: true },
    { id: 'b', sourceType: 'twitch_highlight_short', youtubeVideoId: 'yt-b', tiktokAutoSendConsent: true },
    { id: 'c', sourceType: 'twitch_highlight_short', youtubeVideoId: 'yt-c', tiktokAutoSendConsent: false },
    { id: 'd', sourceType: 'twitch_highlight_batch', youtubeVideoId: 'yt-d', tiktokAutoSendConsent: true }
  ]);
  const calls = [];
  const sent = [];
  const monitor = createShortViewMonitor({
    store,
    youtube: { getVideoViews: async (ids) => {
      calls.push(ids);
      return [video('yt-a', 2001), video('yt-b', 6000, 'private'), video('yt-c', 4000)];
    } },
    onEligible: async (draft) => {
      sent.push(draft.id);
      await store.updateDraft(draft.id, { tiktokAttemptedAt: new Date().toISOString(), tiktokStatus: 'preparing' });
    }
  });
  await monitor.refreshAll();
  await monitor.refreshAll();
  assert.deepEqual(sent, ['a']);
  assert.deepEqual(calls, [['yt-a', 'yt-b', 'yt-c'], ['yt-b', 'yt-c']]);
  assert.equal(store.records.get('a').tiktokEligible, true);
  assert.equal(store.records.get('b').tiktokEligible, false);
  assert.equal(store.records.get('c').tiktokEligible, true);
});

test('YouTube failure never turns a Short into a delivery candidate', async () => {
  const store = fakeStore([{ id: 'a', sourceType: 'twitch_highlight_short',
    youtubeVideoId: 'yt-a', tiktokAutoSendConsent: true }]);
  let sent = false;
  const monitor = createShortViewMonitor({
    store,
    youtube: { getVideoViews: async () => { throw new Error('YouTube unavailable'); } },
    onEligible: async () => { sent = true; }
  });
  await assert.rejects(monitor.refreshAll(), /YouTube unavailable/);
  assert.equal(sent, false);
  assert.equal(store.records.get('a').tiktokEligible, undefined);
});

test('an absent video never inherits a prior eligible view count', async () => {
  const store = fakeStore([{ id: 'a', sourceType: 'twitch_highlight_short',
    youtubeVideoId: 'yt-a', tiktokAutoSendConsent: true, tiktokEligible: true, youtubeViews: 3000 }]);
  let sent = false;
  const monitor = createShortViewMonitor({
    store,
    youtube: { getVideoViews: async () => [] },
    onEligible: async () => { sent = true; }
  });
  await monitor.refreshOne('a');
  assert.equal(store.records.get('a').tiktokEligible, false);
  assert.equal(store.records.get('a').youtubeViews, null);
  assert.equal(sent, false);
});
