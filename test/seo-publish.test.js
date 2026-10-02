const test = require('node:test');
const assert = require('node:assert/strict');
const { auditVideo, automaticVideoEdit, channelSuggestions, channelEdit,
  createSeoPublisher } = require('../src/seo-publish');
const { createSeoWorker } = require('../src/seo-worker');

function item(overrides = {}) {
  return {
    videoId: 'abcdefghijk',
    status: 'needs_review',
    generatedAt: '2026-10-02T00:00:00.000Z',
    source: {
      title: 'ARC Raiders first look', description: 'My links: https://example.com\nAffiliate disclosure: paid links',
      tags: ['ARC Raiders'], channelId: 'channel-1', privacyStatus: 'public', durationSeconds: 180
    },
    context: { takeaways: '' },
    analysis: { summary: 'Gameplay from ARC Raiders' },
    package: {
      primaryKeyword: 'ARC Raiders',
      titles: { hybrid: ['ARC Raiders Gameplay Highlights'] },
      hook: 'ARC Raiders gameplay and highlights from the stream.',
      paragraphs: ['A look at the match and reactions.'],
      tags: ['ARC Raiders', 'gaming highlights'],
      hashtags: ['#ARCRaiders'],
      description: '[Add verified chapters after reviewing footage]\nRelated video: [add URL]',
      missingEvidence: ['Three verified chapter markers are needed']
    },
    ...overrides
  };
}

test('automatic copy preserves existing links and disclosures without inserting placeholders or unverified chapters', () => {
  const edit = automaticVideoEdit(item());
  assert.equal(edit.title, 'ARC Raiders Gameplay Highlights');
  assert.match(edit.description, /https:\/\/example.com/);
  assert.match(edit.description, /Affiliate disclosure: paid links/);
  assert.doesNotMatch(edit.description, /\[add URL\]|Chapters/);
  assert.deepEqual(edit.tags, ['ARC Raiders', 'gaming highlights']);
  assert.ok(auditVideo(item()).some((finding) => finding.includes('keyword')));
});

test('automatic publishing requires public source and actual video evidence', () => {
  assert.throws(() => automaticVideoEdit(item({ source: { ...item().source, privacyStatus: 'private' } })),
    /Only existing public videos/);
  assert.throws(() => automaticVideoEdit(item({ analysis: null })), /Video analysis or owner/);
  assert.throws(() => automaticVideoEdit(item({
    package: { ...item().package, missingEvidence: ['Script or key takeaways needed'] }
  })), /insufficient evidence/);
});

test('regeneration replaces prior generated copy without duplicating it', () => {
  const first = item();
  const edit = automaticVideoEdit(first);
  const next = item({
    source: { ...first.source, ...edit },
    applied: { ...edit, originalDescription: first.source.description,
      originalTags: first.source.tags }
  });
  const repeated = automaticVideoEdit(next);
  assert.equal(repeated.description, edit.description);
  assert.deepEqual(repeated.tags, edit.tags);
});

test('a full existing description still permits title and tag improvements without losing its text', () => {
  const longDescription = 'Original links and disclosures. '.repeat(155).trim();
  const row = item({ source: { ...item().source, description: longDescription } });
  const edit = automaticVideoEdit(row);
  assert.equal(edit.description, longDescription);
  assert.equal(edit.title, 'ARC Raiders Gameplay Highlights');
  assert.deepEqual(edit.tags, ['ARC Raiders', 'gaming highlights']);
});

test('description length uses YouTube UTF-8 byte limit', () => {
  const original = `Gameplay notes: ${'🎮'.repeat(1230)}`;
  assert.ok(Buffer.byteLength(original, 'utf8') < 5000);
  const edit = automaticVideoEdit(item({ source: { ...item().source, description: original } }));
  assert.ok(edit.description === original);
  assert.ok(Buffer.byteLength(edit.description, 'utf8') <= 5000);
});

test('publisher updates only a matching public video, with no visibility update', async () => {
  const row = item();
  const events = [];
  const store = {
    getSeoVideo: async () => row,
    getSeoSyncState: async () => ({ channelId: 'channel-1' }),
    markSeoApplied: async (_id, applied) => events.push(['applied', applied]),
    markSeoAutoResult: async (_id, result) => events.push(['result', result]),
    upsertSeoVideo: async (_id, source) => events.push(['source', source])
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async (id) => { assert.equal(id, 'channel-1'); },
    getVideo: async () => ({ snippet: { ...row.source, categoryId: '20' },
      status: { privacyStatus: 'public' } }),
    updateVideoSeo: async (_id, _video, edit) => {
      events.push(['youtube', edit]);
      assert.equal(Object.hasOwn(edit, 'status'), false);
    }
  };
  const publisher = createSeoPublisher({ store, youtube, logger: { info() {}, warn() {} } });
  await publisher.publishVideo(row.videoId);
  assert.deepEqual(events.map(([type]) => type), ['youtube', 'applied', 'source', 'result']);
  assert.equal(events.at(-1)[1].state, 'applied');
});

test('publisher does not edit private or newly unlisted videos', async () => {
  let updates = 0;
  let result;
  const row = item();
  const store = {
    getSeoVideo: async () => row,
    getSeoSyncState: async () => ({ channelId: 'channel-1' }),
    markSeoAutoResult: async (_id, value) => { result = value; }
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async () => {},
    getVideo: async () => ({ snippet: { ...row.source, categoryId: '20' },
      status: { privacyStatus: 'unlisted' } }),
    updateVideoSeo: async () => { updates += 1; }
  };
  const publisher = createSeoPublisher({ store, youtube, logger: { info() {}, warn() {} } });
  await publisher.publishVideo(row.videoId);
  assert.equal(updates, 0);
  assert.equal(result.state, 'skipped');
  await publisher.publishVideo(row.videoId);
  assert.equal(updates, 0);
  const privatePublisher = createSeoPublisher({
    store: { getSeoVideo: async () => item({ source: { ...row.source, privacyStatus: 'private' } }) },
    youtube, logger: { info() {}, warn() {} }
  });
  await privatePublisher.publishVideo(row.videoId);
  assert.equal(updates, 0);
});

test('publisher does not change an active public livestream', async () => {
  const row = item();
  let updated = false;
  let outcome;
  const publisher = createSeoPublisher({
    store: {
      getSeoVideo: async () => row,
      getSeoSyncState: async () => ({ channelId: 'channel-1' }),
      markSeoAutoResult: async (_id, result) => { outcome = result; }
    },
    youtube: {
      ownedChannel: async () => ({ id: 'channel-1' }),
      assertTargetChannel: async () => {},
      getVideo: async () => ({
        snippet: { ...row.source, categoryId: '20', liveBroadcastContent: 'live' },
        status: { privacyStatus: 'public' }
      }),
      updateVideoSeo: async () => { updated = true; }
    },
    logger: { warn() {}, info() {} }
  });
  await publisher.publishVideo(row.videoId);
  assert.equal(updated, false);
  assert.equal(outcome.state, 'retry');
});

test('publisher rejects a wrong channel, changed metadata, and exhausted daily budget', async () => {
  const row = item();
  const cases = [
    { channelId: 'another-channel', title: row.source.title, budget: 0,
      reason: /not on the connected channel/, state: 'retry' },
    { channelId: 'channel-1', title: 'Owner edited this video', budget: 0,
      reason: /metadata changed/, state: 'skipped' },
    { channelId: 'channel-1', title: row.source.title, budget: 50,
      reason: /budget reached/, state: 'retry' }
  ];
  for (const value of cases) {
    let outcome;
    let updated = false;
    const publisher = createSeoPublisher({
      store: {
        getSeoVideo: async () => row,
        getSeoSyncState: async () => ({ channelId: 'channel-1' }),
        seoUpdatesToday: async () => value.budget,
        markSeoAutoResult: async (_id, result) => { outcome = result; }
      },
      youtube: {
        ownedChannel: async () => ({ id: 'channel-1' }),
        assertTargetChannel: async () => {},
        getVideo: async () => ({
          snippet: { ...row.source, channelId: value.channelId, title: value.title,
            categoryId: '20', liveBroadcastContent: 'none' },
          status: { privacyStatus: 'public' }
        }),
        updateVideoSeo: async () => { updated = true; }
      },
      logger: { warn() {}, info() {} }
    });
    await publisher.publishVideo(row.videoId);
    assert.equal(updated, false);
    assert.match(outcome.reason, value.reason);
    assert.equal(outcome.state, value.state);
  }
});

test('publisher respects an already applied package and retries temporary API failures', async () => {
  const row = item();
  let calls = 0;
  let result;
  const store = {
    getSeoVideo: async () => row,
    getSeoSyncState: async () => ({ channelId: 'channel-1' }),
    markSeoAutoResult: async (_id, value) => { result = value; }
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async () => {},
    getVideo: async () => ({ snippet: { ...row.source, categoryId: '20' },
      status: { privacyStatus: 'public' } }),
    updateVideoSeo: async () => {
      calls += 1;
      const error = new Error('YouTube temporarily unavailable');
      error.status = 503;
      throw error;
    }
  };
  const publisher = createSeoPublisher({ store, youtube, logger: { warn() {}, info() {} } });
  await publisher.publishVideo(row.videoId);
  assert.equal(result.state, 'retry');
  assert.equal(calls, 1);
  row.autoResult = { state: 'applied', packageGeneratedAt: row.generatedAt };
  await publisher.publishVideo(row.videoId);
  assert.equal(calls, 1);
});

test('channel keywords derive from analyzed public videos and retain existing description', async () => {
  const publicRow = item();
  const privateRow = item({ source: { ...item().source, privacyStatus: 'private' },
    package: { ...item().package, primaryKeyword: 'secret keyword' } });
  assert.deepEqual(channelSuggestions([publicRow, privateRow]), ['ARC Raiders']);
  const edit = channelEdit({ title: 'Saevond', description: 'Existing channel identity.',
    keywords: 'gaming', id: 'channel-1' }, ['ARC Raiders']);
  assert.deepEqual(edit, { description: 'Existing channel identity.', keywords: 'gaming "ARC Raiders"' });
  let saved = null;
  const publisher = createSeoPublisher({
    store: {
      getSeoSyncState: async () => ({ channelId: 'channel-1' }),
      listSeoVideos: async () => [publicRow, privateRow]
    },
    youtube: {
      channelSeo: async () => ({ title: 'Saevond', description: 'Existing channel identity.',
        keywords: 'gaming', id: 'channel-1' }),
      assertTargetChannel: async () => {},
      updateChannelSeo: async (_current, value) => { saved = value; }
    },
    logger: { info() {}, warn() {} }
  });
  await publisher.updateChannel();
  assert.deepEqual(saved, edit);
});

test('worker requeues one older public package for footage analysis when Gemini is available', async () => {
  let queued = 0;
  const state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, enabled: true };
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async () => {},
    nextSeoNeedsAnalysis: async () => ({ videoId: 'abcdefghijk', context: {} }),
    updateSeoContext: async () => { queued += 1; },
    seoCounts: async () => ({ attemptedToday: 1 })
  };
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Saevond', uploads: 'uploads-1' })
  };
  const worker = createSeoWorker({ store, youtube, env: {
    ENABLE_VIDEO_ANALYSIS: 'true', SEO_AI_API_KEY: 'test', SEO_AI_MODEL: 'gemini-model',
    SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    SEO_DAILY_LIMIT: '1'
  }, logger: { info() {}, error() {} } });
  await worker.run();
  assert.equal(queued, 1);
  state.videoAnalysisBlockedUntil = new Date(Date.now() + 3600000).toISOString();
  await worker.run();
  assert.equal(queued, 1);
});

test('automatic publishing requires the explicit owner-approved setting', async () => {
  const store = {
    listSeoAutoCandidates: async () => [],
    getSeoSyncState: async () => ({ enabled: true }),
    seoCounts: async () => ({ statuses: {}, attemptedToday: 0 })
  };
  const youtube = { updateVideoSeo: async () => {} };
  for (const [setting, expected] of [[undefined, false], ['false', false], ['true', true]]) {
    const worker = createSeoWorker({ store, youtube, env: { SEO_AUTO_PUBLISH: setting } });
    assert.equal((await worker.status()).autoPublishEnabled, expected);
  }
});

test('worker analyzes a public upload, publishes its SEO, and updates channel keywords once', async () => {
  const visibility = ['public', 'private', 'unlisted'];
  const original = new Map(visibility.map((privacyStatus, index) => {
    const id = `video-${index}`;
    return [id, {
      id, snippet: { title: `ARC Raiders match ${index}`, description: 'Original links: https://example.com',
        tags: ['ARC Raiders'], channelId: 'channel-1', categoryId: '20',
        publishedAt: '2026-10-01T10:00:00.000Z', liveBroadcastContent: 'none' },
      status: { privacyStatus }, contentDetails: { duration: 'PT3M' }, etag: `etag-${index}`
    }];
  }));
  const rows = new Map();
  const events = [];
  let sync = { enabled: true, completed: false, cursor: null };
  let channelKeywords = 'gaming';
  const store = {
    upsertSeoVideo: async (id, source) => {
      rows.set(id, { ...(rows.get(id) || { videoId: id, status: 'queued', context: {} }), source });
    },
    getSeoSyncState: async () => sync,
    saveSeoSyncState: async (state) => { sync = state; },
    listSeoAutoCandidates: async () => [...rows.values()].filter((row) =>
      row.package && row.source.privacyStatus === 'public' && !row.autoResult),
    listSeoVideos: async () => [...rows.values()],
    getSeoVideo: async (id) => rows.get(id),
    getVideoAnalysis: async () => null,
    saveVideoAnalysis: async (id, analysis) => { rows.get(id).analysis = analysis; },
    seoCounts: async () => ({ statuses: {}, attemptedToday: 0 }),
    claimSeoVideo: async () => {
      const row = [...rows.values()].find((candidate) =>
        candidate.status === 'queued' && candidate.source.privacyStatus === 'public');
      if (!row) return null;
      row.status = 'generating';
      return { ...row, claimToken: 'claim-1', attempts: 1 };
    },
    finishSeoVideo: async (id, _token, generated) => {
      Object.assign(rows.get(id), { package: generated, status: 'ready',
        generatedAt: '2026-10-02T00:00:00.000Z' });
    },
    markSeoApplied: async (id, applied) => { rows.get(id).applied = applied; },
    markSeoAutoResult: async (id, result) => { rows.get(id).autoResult = result; },
    seoUpdatesToday: async () => 0
  };
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Saevond', uploads: 'uploads-1' }),
    uploadsPage: async () => ({ ids: [...original.keys()], nextPageToken: null }),
    videoMetadata: async (ids) => ids.map((id) => original.get(id)),
    getVideo: async (id) => original.get(id),
    assertTargetChannel: async (id) => { assert.equal(id, 'channel-1'); },
    channelSeo: async () => ({ id: 'channel-1', title: 'Saevond',
      description: 'Original channel description', keywords: channelKeywords }),
    updateVideoSeo: async (id, video, edit) => {
      assert.equal(video.status.privacyStatus, 'public');
      assert.equal(Object.hasOwn(edit, 'status'), false);
      events.push(['video', id]);
      Object.assign(video.snippet, edit);
    },
    updateChannelSeo: async (_channel, edit) => {
      events.push(['channel', edit]);
      channelKeywords = edit.keywords;
    }
  };
  const diagnostics = [];
  const worker = createSeoWorker({ store, youtube, env: {
    SEO_AUTO_PUBLISH: 'true', ENABLE_VIDEO_ANALYSIS: 'true',
    SEO_AI_API_KEY: 'fixture-key', SEO_AI_MODEL: 'fixture-model',
    VIDEO_ANALYSIS_API_KEY: 'fixture-key', SEO_DAILY_LIMIT: '3'
  }, logger: {
    info: (message) => diagnostics.push(message), warn: (message) => diagnostics.push(message),
    error: (message) => diagnostics.push(message)
  }, analyze: async (url) => {
    assert.match(url, /video-0$/);
    events.push(['analysis', 'video-0']);
    return { summary: 'An ARC Raiders match' };
  }, generate: async (source, _context, options) => {
    assert.equal(source.privacyStatus, 'public');
    assert.equal(options.analysis.summary, 'An ARC Raiders match');
    events.push(['package', 'video-0']);
    return { ...item().package, missingEvidence: [] };
  } });
  await worker.run();
  assert.deepEqual(events.map(([kind]) => kind), ['analysis', 'package', 'video', 'channel']);
  assert.equal(rows.get('video-0').autoResult.state, 'applied');
  assert.equal(rows.get('video-0').applied.privacyStatus, 'public');
  assert.equal(rows.get('video-1').package, undefined);
  assert.equal(rows.get('video-2').package, undefined);
  assert.equal(original.get('video-1').snippet.title, 'ARC Raiders match 1');
  assert.equal(original.get('video-2').snippet.title, 'ARC Raiders match 2');
  assert.equal(channelKeywords, 'gaming "ARC Raiders"');
  assert.ok(diagnostics.some((line) => line.includes('providerConfigured":true')));
  await worker.run();
  assert.equal(events.length, 4);
});

test('worker reports missing YouTube connection once without accessing the catalog', async () => {
  const logs = [];
  const worker = createSeoWorker({ store: {}, youtube: {
    isConnected: async () => false,
    ownedChannel: async () => { throw new Error('Should not scan'); }
  }, logger: { info: (line) => logs.push(line) } });
  await worker.run();
  await worker.run();
  assert.deepEqual(logs, ['SEO worker idle: YouTube is not connected']);
});
