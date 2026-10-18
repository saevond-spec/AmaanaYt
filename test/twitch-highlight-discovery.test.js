'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTwitchHighlightDiscovery,
  selectCommunityHighlights,
  scanIntervalForVod
} = require('../src/twitch-highlight-discovery');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function makeVod(id = '1001', overrides = {}) {
  return {
    id,
    type: 'archive',
    user_id: 'broadcaster-1',
    user_name: 'AmaanaYT',
    user_login: 'amaanayt',
    title: 'Ranked gaming session',
    duration: '2h',
    created_at: '2026-10-18T12:00:00.000Z',
    ...overrides
  };
}

function makeClip(id, offset, duration = 20, views = 1, overrides = {}) {
  return {
    id,
    video_id: '1001',
    broadcaster_id: 'broadcaster-1',
    vod_offset: offset,
    duration,
    view_count: views,
    title: `Moment ${id}`,
    created_at: '2026-10-18T14:00:00.000Z',
    ...overrides
  };
}

function harness({ vods = [makeVod()], clipsByVod = {}, initialDrafts = [], startAt = Date.parse('2026-10-18T15:00:00.000Z'),
  now = () => startAt, getVodError, listError, clipErrorByVod = {}, onClipsRead } = {}) {
  let clock = startAt;
  let persistedState = null;
  const drafts = [...initialDrafts];
  const enqueued = [];
  const calls = { vodList: 0, vodGet: 0, clipList: 0, stateSaves: 0 };
  const twitch = {
    async listRecentArchivedVods(options) {
      calls.vodList += 1;
      calls.vodListOptions = options;
      if (listError) throw listError;
      return vods;
    },
    async getVod(id) {
      calls.vodGet += 1;
      if (getVodError) throw getVodError;
      return vods.find((vod) => String(vod.id) === String(id)) || makeVod(String(id));
    },
    async listClipsForVod(vod) {
      calls.clipList += 1;
      onClipsRead?.(vod);
      if (clipErrorByVod[String(vod.id)]) throw clipErrorByVod[String(vod.id)];
      return typeof clipsByVod[String(vod.id)] === 'function'
        ? clipsByVod[String(vod.id)]()
        : clipsByVod[String(vod.id)] || [];
    }
  };
  const store = {
    async listDrafts() { return drafts.slice(); },
    async addDraft(draft) {
      if (drafts.some((existing) => existing.id === draft.id)) throw new Error('duplicate draft id');
      drafts.push(draft);
      return draft;
    },
    async getTwitchHighlightDiscoveryState() { return persistedState; },
    async saveTwitchHighlightDiscoveryState(state) {
      calls.stateSaves += 1;
      persistedState = structuredClone(state);
    }
  };
  const logger = { info() {}, warn() {}, error() {} };
  const discovery = createTwitchHighlightDiscovery({
    twitch, store, enqueueBatch: (id) => enqueued.push(id), logger,
    idFactory: (() => { let id = 0; return () => `batch-${++id}`; })(), now,
    scanIntervalMs: 15 * MINUTE
  });
  return {
    discovery, twitch, store, drafts, enqueued, calls, get state() { return persistedState; },
    setNow(value) { clock = value; startAt = value; },
    getNow() { return clock; }
  };
}

test('selects only linked, in-range clips and ranks non-overlapping moments by views', () => {
  const vod = makeVod();
  const clips = [
    makeClip('top', 100, 20, 100),
    makeClip('overlap', 105, 20, 99),
    makeClip('earlier', 5, 30, 50),
    makeClip('backfill', 200, 15, 10),
    makeClip('wrong-vod', 300, 20, 10000, { video_id: '9999' }),
    makeClip('wrong-channel', 400, 20, 10000, { broadcaster_id: 'other' }),
    makeClip('unlinked', null, 20, 10000, { video_id: '' }),
    makeClip('no-offset', null, 20, 10000),
    makeClip('negative', -2, 20, 10000),
    makeClip('too-short', 500, 4.9, 10000),
    makeClip('too-long', 600, 60.1, 10000),
    makeClip('beyond-vod', 7190, 20, 10000)
  ];

  const result = selectCommunityHighlights(clips, vod);
  assert.deepEqual(result.evidence.map((item) => item.clipId), ['earlier', 'top', 'backfill']);
  assert.deepEqual(result.highlights.map((item) => item.startSeconds), [5, 100, 200]);
  assert.equal(result.highlights[1].reason, 'Twitch community clip (100 views): Moment top');
  assert.equal(result.highlights[0].score, null);
});

test('enforces the five-output cap and backfills lower ranked non-overlapping clips', () => {
  const vod = makeVod();
  const clips = [
    ...Array.from({ length: 8 }, (_, index) => makeClip(`clip-${index}`, index * 100, 20, 100 - index)),
    makeClip('lower-ranked', 1000, 15, 1)
  ];
  const result = selectCommunityHighlights(clips, vod, { limit: 5 });
  assert.equal(result.highlights.length, 5);
  assert.deepEqual(result.evidence.map((item) => item.clipId), ['clip-0', 'clip-1', 'clip-2', 'clip-3', 'clip-4']);
  assert.equal(selectCommunityHighlights(clips, vod, { limit: 100 }).highlights.length, 5);
});

test('returns no candidate when Twitch has not linked community clips to the VOD yet', () => {
  const result = selectCommunityHighlights([
    makeClip('live-clip', 200, 20, 500, { video_id: '', vod_offset: null })
  ], makeVod());
  assert.deepEqual(result.highlights, []);
  assert.deepEqual(result.evidence, []);
});

test('rejects invalid archive duration rather than guessing a timestamp boundary', () => {
  assert.throws(() => selectCommunityHighlights([], makeVod('1001', { duration: 'unknown' })), /invalid VOD duration/);
});

test('creates one private-pipeline batch from Amaana-discovered Twitch clip evidence', async () => {
  const vod = makeVod();
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: [
    makeClip('community-1', 300, 25, 40), makeClip('community-2', 900, 15, 5)
  ] } });
  const result = await h.discovery.run();
  assert.equal(result.queued, 1);
  assert.equal(result.scanned, 1);
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].discoverySource, 'twitch_clips_api');
  assert.equal(h.drafts[0].sourceType, 'twitch_highlight_batch');
  assert.equal(h.drafts[0].sourceChannel, 'AmaanaYT');
  assert.equal(h.drafts[0].sourceClipEvidence.length, 2);
  assert.equal(h.drafts[0].highlights[0].startSeconds, 300);
  assert.equal(h.drafts[0].highlights[1].startSeconds, 900);
  assert.deepEqual(h.enqueued, ['batch-1']);
  assert.equal(h.calls.vodListOptions.first, 20);
});

test('ignores active streams and non-archive entries even if a provider returns them', async () => {
  const archive = makeVod();
  const live = makeVod('1002', { type: 'live' });
  const h = harness({ vods: [live, archive], clipsByVod: { [archive.id]: [makeClip('one', 10, 15, 1)] } });
  const result = await h.discovery.run();
  assert.equal(result.scanned, 1);
  assert.equal(h.calls.clipList, 1);
  assert.equal(h.drafts[0].vodId, archive.id);
});

test('saves an empty scan and retries after Twitch’s delayed VOD offset becomes available', async () => {
  const vod = makeVod();
  const clips = [];
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: () => clips } });
  const first = await h.discovery.run();
  assert.equal(first.noCandidates, 1);
  assert.equal(h.drafts.length, 0);
  assert.equal(h.state.lastScannedAt[vod.id], new Date(h.getNow()).toISOString());

  h.setNow(h.getNow() + 14 * MINUTE);
  const throttled = await h.discovery.run();
  assert.equal(throttled.throttled, 1);
  assert.equal(h.calls.clipList, 1);

  clips.push(makeClip('late-linked-clip', 123, 20, 6));
  h.setNow(h.getNow() + 1 * MINUTE);
  const retried = await h.discovery.run();
  assert.equal(retried.queued, 1);
  assert.equal(h.drafts[0].sourceClipEvidence[0].clipId, 'late-linked-clip');
});

test('restores scan throttles from persistent storage after a worker restart', async () => {
  const vod = makeVod();
  const h = harness({ vods: [vod] });
  await h.discovery.run();
  h.setNow(h.getNow() + 5 * MINUTE);
  const restarted = createTwitchHighlightDiscovery({
    twitch: h.twitch,
    store: h.store,
    enqueueBatch: (id) => h.enqueued.push(id),
    logger: { info() {}, error() {} },
    now: h.getNow,
    scanIntervalMs: 15 * MINUTE
  });
  const result = await restarted.run();
  assert.equal(result.throttled, 1);
  assert.equal(h.calls.clipList, 1);
});

test('does not duplicate a batch already created for the VOD', async () => {
  const vod = makeVod();
  const existing = { id: 'existing', sourceType: 'twitch_highlight_batch', vodId: vod.id };
  const h = harness({ vods: [vod], initialDrafts: [existing] });
  const result = await h.discovery.run();
  assert.equal(result.alreadyExists, 1);
  assert.equal(h.calls.clipList, 0);
  assert.deepEqual(h.enqueued, []);
});

test('continues scanning other VODs after one Twitch request fails', async () => {
  const first = makeVod('1001');
  const second = makeVod('1002');
  const h = harness({
    vods: [first, second],
    clipsByVod: { [second.id]: [makeClip('second-clip', 50, 15, 2, { video_id: second.id })] },
    clipErrorByVod: { [first.id]: new Error('temporary Twitch API issue') }
  });
  const result = await h.discovery.run();
  assert.equal(result.errors, 1);
  assert.equal(result.queued, 1);
  assert.equal(h.drafts[0].vodId, second.id);
  assert.equal(h.state.lastScannedAt[first.id], undefined);
});

test('manual VOD scans resolve the ID through Amaana’s own broadcaster authorization', async () => {
  const vod = makeVod();
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: [makeClip('manual-clip', 360, 30, 8)] } });
  const result = await h.discovery.scanVod(vod.id);
  assert.equal(result.status, 'queued');
  assert.equal(h.calls.vodGet, 1);
  assert.equal(h.calls.clipList, 1);
  assert.equal(h.drafts[0].sourceClipEvidence[0].clipId, 'manual-clip');
});

test('manual scan fails closed when the authorized VOD lookup fails', async () => {
  const h = harness({ getVodError: Object.assign(new Error('not the connected broadcaster'), { status: 403 }) });
  await assert.rejects(h.discovery.scanVod('1001'), /not the connected broadcaster/);
  assert.equal(h.calls.clipList, 0);
  assert.equal(h.drafts.length, 0);
});

test('simultaneous scans for one VOD share a single Twitch clip lookup', async () => {
  const vod = makeVod();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: async () => {
    started();
    await gate;
    return [makeClip('concurrent-clip', 600, 25, 3)];
  } } });
  const first = h.discovery.scanVod(vod);
  await startedPromise;
  const second = await h.discovery.scanVod(vod);
  assert.equal(second.status, 'already_scanning');
  release();
  assert.equal((await first).status, 'queued');
  assert.equal(h.calls.clipList, 1);
  assert.equal(h.drafts.length, 1);
});

test('overlapping scheduled runs do not start a second VOD inventory request', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const vod = makeVod();
  const h = harness({ vods: [vod] });
  const original = h.twitch.listRecentArchivedVods;
  h.twitch.listRecentArchivedVods = async (...args) => {
    started();
    await gate;
    return original(...args);
  };
  const first = h.discovery.run();
  await startedPromise;
  assert.deepEqual(await h.discovery.run(), { skipped: 'already_running' });
  release();
  await first;
  assert.equal(h.calls.vodList, 1);
});

test('scanner records a broken Twitch inventory without throwing out of the timer callback', async () => {
  const h = harness({ listError: new Error('Twitch unavailable') });
  const result = await h.discovery.run();
  assert.equal(result.errors, 0);
  assert.equal(h.discovery.status().lastRunError, 'Twitch unavailable');
  assert.ok(h.discovery.status().lastRunAt);
});

test('does not call Twitch Helix while the Amaana Twitch connection is disconnected', async () => {
  const h = harness();
  h.twitch.isConnected = async () => false;
  const result = await h.discovery.run();
  assert.equal(result.notConnected, true);
  assert.equal(h.calls.vodList, 0);
  assert.equal(h.calls.clipList, 0);
});

test('five-year daily rescan projection stays bounded for old VODs', async () => {
  const vod = makeVod('1001', { created_at: '2019-12-20T00:00:00.000Z' });
  const startAt = Date.parse('2020-01-01T00:00:00.000Z');
  const h = harness({ vods: [vod], startAt });
  const numberOfDays = 365 * 5 + 1;
  for (let day = 0; day < numberOfDays; day += 1) {
    h.setNow(startAt + day * DAY);
    await h.discovery.run();
  }
  assert.equal(h.calls.clipList, numberOfDays);
  assert.equal(h.drafts.length, 0);
  assert.equal(scanIntervalForVod(vod, startAt + numberOfDays * DAY), DAY);
});

