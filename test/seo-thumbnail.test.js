const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeoPublisher } = require('../src/seo-publish');

function makeItem(index, privacyStatus = 'public') {
  const videoId = 'thumb' + String(index).padStart(6, '0');
  const source = {
    title: 'ARC Raiders floating raider ' + index,
    description: 'Gameplay details from the ARC Raiders match with the floating raider encounter. '.repeat(2),
    tags: ['ARC Raiders', 'gameplay'],
    channelId: 'channel-1',
    privacyStatus,
    durationSeconds: 180
  };
  return {
    videoId, status: 'needs_review', generatedAt: '2026-10-02T00:00:00.000Z',
    source, context: { takeaways: '' }, analysis: null,
    package: {
      primaryKeyword: 'ARC Raiders',
      titles: { hybrid: ['ARC Raiders floating raider encounter'] },
      thumbnails: [{ visual: 'Use the current gameplay image', overlay: 'FLOATING RAIDER',
        palette: 'Black, yellow, and white', hook: 'The unexpected movement' }],
      hook: 'ARC Raiders gameplay shows the floating raider encounter.',
      paragraphs: ['The existing video description identifies the match and its gameplay context.'],
      tags: ['ARC Raiders', 'gameplay'],
      hashtags: ['#ARCRaiders'],
      missingEvidence: ['Three verified chapter markers are needed']
    },
    applied: null,
    autoResult: null
  };
}

function responseImage() {
  return new Response(Buffer.from('source-image'), {
    headers: { 'content-type': 'image/jpeg' }
  });
}

function makeHarness(count, options = {}) {
  const rows = new Map();
  const live = new Map();
  for (let i = 0; i < count; i += 1) {
    const row = makeItem(i, options.privacy?.[i] || 'public');
    rows.set(row.videoId, row);
    live.set(row.videoId, {
      snippet: { ...row.source, categoryId: '20', liveBroadcastContent: 'none',
        thumbnails: { high: { url: 'https://i.ytimg.com/vi/' + row.videoId + '/hqdefault.jpg',
          width: 480, height: 360 } } },
      status: { privacyStatus: row.source.privacyStatus }
    });
  }
  let dailyWrites = 0;
  let metadataWrites = 0;
  let thumbnailWrites = 0;
  const store = {
    listSeoAutoCandidates: async (limit = 20) => [...rows.values()].filter((row) =>
      row.source.privacyStatus === 'public' && row.package &&
      (!row.autoResult || row.autoResult.state === 'retry' ||
       row.autoResult.thumbnailState === 'retry' ||
       row.autoResult.packageGeneratedAt !== row.generatedAt ||
       row.autoResult.thumbnailState == null))
      .slice(0, limit).map((row) => ({ videoId: row.videoId })),
    getSeoVideo: async (videoId) => rows.get(videoId),
    getSeoSyncState: async () => ({ channelId: 'channel-1' }),
    seoUpdatesToday: async () => dailyWrites,
    markSeoApplied: async (videoId, applied) => {
      rows.get(videoId).applied = applied;
      dailyWrites += 1;
      metadataWrites += 1;
    },
    upsertSeoVideo: async (videoId, source) => { rows.get(videoId).source = source; },
    markSeoAutoResult: async (videoId, result) => { rows.get(videoId).autoResult = result; }
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async () => {},
    getVideo: async (videoId) => {
      const item = live.get(videoId);
      return { etag: 'etag-' + videoId, snippet: { ...item.snippet, thumbnails: item.snippet.thumbnails },
        status: { ...item.status } };
    },
    updateVideoSeo: async (videoId, video, edit) => {
      assert.equal(Object.hasOwn(edit, 'status'), false);
      assert.equal(video.status.privacyStatus, 'public');
      Object.assign(live.get(videoId).snippet, edit);
      metadataWrites += 0;
    },
    setThumbnail: async (videoId, filePath) => {
      assert.equal(live.get(videoId).status.privacyStatus, 'public');
      assert.equal((await require('node:fs/promises').readFile(filePath))[0], 0xff);
      thumbnailWrites += 1;
      if (options.failFirstThumbnail?.has(videoId) && !options.failed?.has(videoId)) {
        options.failed?.add(videoId);
        const error = new Error('YouTube rate limit');
        error.status = 429;
        throw error;
      }
    }
  };
  const publisher = createSeoPublisher({
    store, youtube,
    fetchImpl: options.fetchImpl || (async () => responseImage()),
    renderThumbnail: async (_input, output) => {
      await require('node:fs/promises').writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    },
    logger: { info() {}, warn() {} }
  });
  return { rows, live, store, youtube, publisher,
    get dailyWrites() { return dailyWrites; },
    resetDay() { dailyWrites = 0; },
    get metadataWrites() { return metadataWrites; },
    get thumbnailWrites() { return thumbnailWrites; }
  };
}

test('legacy context skips are rechecked and long public descriptions receive SEO plus a grounded thumbnail', async () => {
  const row = makeItem(0);
  row.autoResult = {
    state: 'skipped',
    reason: 'Video analysis or owner supplied video context is required for automatic publishing',
    packageGeneratedAt: row.generatedAt
  };
  const h = makeHarness(1);
  h.rows.set(row.videoId, row);
  h.live.set(row.videoId, {
    snippet: { ...row.source, categoryId: '20', liveBroadcastContent: 'none',
      thumbnails: { high: { url: 'https://i.ytimg.com/vi/' + row.videoId + '/hqdefault.jpg',
        width: 480, height: 360 } } },
    status: { privacyStatus: 'public' }
  });
  let stored;
  h.store.markSeoAutoResult = async (_id, result) => { stored = result; row.autoResult = result; };
  await h.publisher.publishVideo(row.videoId);
  assert.equal(row.source.privacyStatus, 'public');
  assert.equal(row.applied.privacyStatus, 'public');
  assert.equal(stored.state, 'applied');
  assert.equal(stored.thumbnailState, 'applied');
  assert.equal(stored.thumbnailHeadline, 'FLOATING RAIDER');
  assert.equal(h.metadataWrites, 1);
  assert.equal(h.thumbnailWrites, 1);
});

test('untrusted thumbnail URLs are rejected without fetching them', async () => {
  let fetchCalls = 0;
  const h = makeHarness(1, { fetchImpl: async () => { fetchCalls += 1; return responseImage(); } });
  h.live.get('thumb000000').snippet.thumbnails.high.url = 'https://attacker.example/image.jpg';
  const result = await h.publisher.publishVideo('thumb000000');
  assert.equal(result.state, 'applied');
  assert.equal(result.thumbnailState, 'skipped');
  assert.match(result.thumbnailReason, /not served by YouTube/i);
  assert.equal(fetchCalls, 0);
  assert.equal(h.metadataWrites, 1);
  assert.equal(h.thumbnailWrites, 0);
});

test('thumbnail download HTTP 429 retries without repeating the metadata write', async () => {
  let cooling = true;
  const h = makeHarness(1, { fetchImpl: async () => cooling
    ? new Response('rate limited', { status: 429 })
    : responseImage() });
  const first = await h.publisher.publishVideo('thumb000000');
  assert.equal(first.state, 'applied');
  assert.equal(first.thumbnailState, 'retry');
  assert.equal(h.metadataWrites, 1);
  cooling = false;
  const second = await h.publisher.publishVideo('thumb000000');
  assert.equal(second.state, 'applied');
  assert.equal(second.thumbnailState, 'applied');
  assert.equal(h.metadataWrites, 1);
  assert.equal(h.thumbnailWrites, 1);
});

test('a live video that is no longer public receives no automatic writes', async () => {
  const h = makeHarness(1);
  h.live.get('thumb000000').status.privacyStatus = 'private';
  const result = await h.publisher.publishVideo('thumb000000');
  assert.equal(result.state, 'skipped');
  assert.equal(result.thumbnailState, 'skipped');
  assert.equal(h.metadataWrites, 0);
  assert.equal(h.thumbnailWrites, 0);
  assert.equal(h.live.get('thumb000000').status.privacyStatus, 'private');
});

test('private and unlisted videos never receive SEO or thumbnail writes', async () => {
  for (const privacyStatus of ['private', 'unlisted']) {
    const h = makeHarness(1, { privacy: { 0: privacyStatus } });
    await h.publisher.publishVideo('thumb000000');
    assert.equal(h.metadataWrites, 0);
    assert.equal(h.thumbnailWrites, 0);
    assert.equal(h.live.get('thumb000000').status.privacyStatus, privacyStatus);
  }
});

test('already-applied SEO can retry a transient thumbnail failure without repeating metadata', async () => {
  const h = makeHarness(1, { failFirstThumbnail: new Set(['thumb000000']), failed: new Set() });
  const row = h.rows.get('thumb000000');
  row.autoResult = { state: 'applied', packageGeneratedAt: row.generatedAt, thumbnailState: 'retry',
    at: '2026-10-03T00:00:00.000Z' };
  row.applied = { title: 'ARC Raiders floating raider 0', description: row.source.description,
    tags: row.source.tags, at: '2026-10-03T00:00:00.000Z', privacyStatus: 'public' };
  const first = await h.publisher.publishVideo(row.videoId);
  assert.equal(first.state, 'applied');
  assert.equal(first.thumbnailState, 'retry');
  assert.equal(h.metadataWrites, 0);
  const second = await h.publisher.publishVideo(row.videoId);
  assert.equal(second.state, 'applied');
  assert.equal(second.thumbnailState, 'applied');
  assert.equal(h.metadataWrites, 0);
  assert.equal(h.thumbnailWrites, 2);
});

test('public backlog drains in daily batches and remains idempotent over a two-year horizon', async () => {
  const privacy = { 130: 'private', 131: 'unlisted' };
  const h = makeHarness(132, { privacy });
  const appliedByDay = [];
  for (let day = 0; day < 730; day += 1) {
    h.resetDay();
    const beforeMeta = h.metadataWrites;
    const beforeThumb = h.thumbnailWrites;
    await h.publisher.publishPending(50);
    const metadataToday = h.metadataWrites - beforeMeta;
    const thumbnailsToday = h.thumbnailWrites - beforeThumb;
    assert.ok(metadataToday <= 50);
    assert.ok(thumbnailsToday <= 50);
    assert.equal(h.dailyWrites, metadataToday);
    if (day < 3) appliedByDay.push(metadataToday);
    else assert.equal(metadataToday, 0);
  }
  assert.deepEqual(appliedByDay, [50, 50, 30]);
  assert.equal(h.metadataWrites, 130);
  assert.equal(h.thumbnailWrites, 130);
  assert.equal([...h.live.values()].filter((video) => video.status.privacyStatus === 'public').length, 130);
  assert.equal(h.live.get('thumb000130').status.privacyStatus, 'private');
  assert.equal(h.live.get('thumb000131').status.privacyStatus, 'unlisted');
});
