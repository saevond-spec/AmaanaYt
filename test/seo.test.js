const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContext, normalizeSource, validatePackage, generatePackage,
  descriptionChapters } = require('../src/seo-package');
const { createSeoWorker } = require('../src/seo-worker');

const keyword = 'NARAKA BLADEPOINT guide';
const hook = 'NARAKA BLADEPOINT guide: Learn the opening strategy, key moments, and practical moves in this gameplay breakdown for players improving today.';
const source = normalizeSource({
  snippet: { title: 'NARAKA BLADEPOINT match', description: 'An intense match with a final fight.',
    tags: ['NARAKA'], channelId: 'channel-1' },
  contentDetails: { duration: 'PT3M10S' }, status: { privacyStatus: 'private' }
});
const context = normalizeContext({ primaryKeyword: keyword, takeaways: 'Opening, first round, final fight',
  markers: [
    { kind: 'chapter', startSeconds: 0, title: 'Opening' },
    { kind: 'chapter', startSeconds: 42, title: 'First round' },
    { kind: 'chapter', startSeconds: 93, title: 'Final fight' },
    { kind: 'clip', startSeconds: 96, endSeconds: 132, title: 'Final fight' },
    { kind: 'clip', startSeconds: 145, endSeconds: 175, title: 'Reaction' }
  ] }, source.durationSeconds);
const generated = {
  primaryKeyword: keyword,
  titles: {
    search: [`${keyword}: First Fight`, `${keyword}: Match Tips`, `${keyword}: Final Fight`],
    curiosity: ['The Last Fight Changed Everything', 'How Did This Match End?', 'I Almost Missed This Moment'],
    hybrid: ['NARAKA Match: The Final Fight', 'NARAKA Gameplay With a Twist', 'NARAKA Guide: Last Fight']
  },
  thumbnails: [1, 2, 3].map((index) => ({
    visual: `Close crop on frame ${index}`, overlay: 'LAST FIGHT', palette: 'Yellow and violet',
    hook: 'Large final moment'
  })),
  hook,
  paragraphs: ['A gameplay match with a clear opening and final fight for players.', 'Review the sequence and takeaways before your next match.'],
  tags: ['NARAKA', 'NARAKA BLADEPOINT', 'NARAKA BLADEPOINT guide', 'gameplay', 'match', 'fight',
    'opening strategy', 'final fight', 'combat tips', 'video game'],
  hashtags: ['#NARAKA', '#Gameplay', '#Gaming'],
  pinnedComment: 'Which round stood out to you most?',
  communityPost: 'Watch the final fight in my latest match.',
  clipHooks: ['The final fight starts here.', 'Watch the reaction at the end.']
};

test('uses only supplied markers for chapters and clips', () => {
  const pkg = validatePackage(generated, source, context);
  assert.equal(pkg.hook.length, 141);
  assert.deepEqual(pkg.chapters, [
    '00:00 - Opening', '00:42 - First round', '01:33 - Final fight'
  ]);
  assert.deepEqual(pkg.shorts.map(({ start, end }) => [start, end]),
    [['01:36', '02:12'], ['02:25', '02:55']]);
  assert.deepEqual(pkg.missingEvidence, []);
  assert.ok(pkg.description.startsWith(hook));
});

test('missing footage evidence creates review flags and no invented timestamps', () => {
  const pkg = validatePackage({ ...generated, clipHooks: [] }, source, normalizeContext({}, 190));
  assert.deepEqual(pkg.chapters, []);
  assert.deepEqual(pkg.shorts, []);
  assert.ok(pkg.description.includes('[Add verified chapters after reviewing footage]'));
  assert.ok(pkg.missingEvidence.length >= 2);
  assert.throws(() => normalizeContext({ markers: [
    { kind: 'clip', startSeconds: 180, endSeconds: 250 }
  ] }, 190), /outside the video duration/);
});

test('reuses only valid chapters from an existing description', () => {
  const description = '00:00 - Intro\n00:42 - First round\n01:33 - Final fight';
  assert.equal(descriptionChapters(description, 190).length, 3);
  assert.deepEqual(descriptionChapters(description, 96), []);
});

test('sends factual input to a configured model and validates the response', async () => {
  let request;
  const pkg = await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'test-model',
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) };
    }
  });
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(pkg.titles.search.length, 3);
  assert.equal(pkg.shorts.length, 2);
  await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'gemini-3.6-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fetchImpl: async (url) => {
      assert.equal(url.toString(), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) };
    }
  });
  assert.throws(() => validatePackage({ ...generated,
    titles: { ...generated.titles, search: ['Unrelated title', ...generated.titles.search.slice(1)] }
  }, source, context), /start with the primary keyword/);
});

test('uses the Gemini fallback model only after a primary HTTP 503', async () => {
  const models = [];
  const pkg = await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fetchImpl: async (_url, options) => {
      models.push(JSON.parse(options.body).model);
      return models.length === 1 ? { ok: false, status: 503 } :
        { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) };
    }
  });
  assert.deepEqual(models, ['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.equal(pkg.titles.search.length, 3);
});

test('uses the native Gemini route if both compatible models return HTTP 503', async () => {
  const requests = [];
  const pkg = await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return requests.length < 3 ? { ok: false, status: 503 } : {
        ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(generated) }] } }] })
      };
    }
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(requests[2].options.headers['x-goog-api-key'], 'unit-test-key');
  assert.equal(JSON.parse(requests[2].options.body).generationConfig.responseMimeType, 'application/json');
  assert.equal(pkg.titles.search.length, 3);
});

test('catalog scan pages through the uploads playlist and preserves a resume cursor', async () => {
  let state = { cursor: null, completed: false, enabled: true };
  const stored = new Map();
  const pages = [];
  const fakeStore = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (value) => { state = value; },
    upsertSeoVideo: async (id, video) => { stored.set(id, video); },
    seoCounts: async () => ({ attemptedToday: 0 })
  };
  const fakeYoutube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' }),
    uploadsPage: async (_playlistId, cursor) => {
      pages.push(cursor || 'recent');
      return cursor ? { ids: ['b'], nextPageToken: null } : { ids: ['a'], nextPageToken: 'older' };
    },
    videoMetadata: async (ids) => ids.map((id) => ({
      id, snippet: { title: id, description: '', channelId: 'channel-1' }
    }))
  };
  const worker = createSeoWorker({ store: fakeStore, youtube: fakeYoutube, env: {} });
  await worker.run();
  assert.deepEqual(pages, ['recent', 'older']);
  assert.deepEqual([...stored.keys()], ['a', 'b']);
  assert.equal(state.completed, true);
  await worker.run();
  assert.deepEqual(pages, ['recent', 'older']);
});

test('generates for catalog videos whose stored context is empty JSON', async () => {
  let claimed = false;
  let finished;
  let requested = false;
  const fakeStore = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', recentAt: new Date().toISOString(),
      completed: true, enabled: true }),
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => {
      if (claimed) return null;
      claimed = true;
      return { videoId: 'video-1', claimToken: 'claim-1', source, context: {}, attempts: 1 };
    },
    finishSeoVideo: async (_videoId, _token, pkg, error) => { finished = { pkg, error }; }
  };
  const fakeYoutube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' })
  };
  const originalFetch = global.fetch;
  global.fetch = async () => {
    requested = true;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) };
  };
  try {
    const worker = createSeoWorker({ store: fakeStore, youtube: fakeYoutube,
      env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'test-model', SEO_DAILY_LIMIT: '1' } });
    await worker.run();
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requested, true);
  assert.equal(finished.error, null);
  assert.ok(finished.pkg.missingEvidence.length > 0);
});

test('pauses provider requests on insufficient balance without failing the video', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, enabled: true };
  let claims = 0;
  let requests = 0;
  let finishError;
  const fakeStore = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => {
      claims += 1;
      return { videoId: 'video-1', claimToken: 'claim-1', source, context: {}, attempts: 3 };
    },
    finishSeoVideo: async (_videoId, _token, _pkg, error) => { finishError = error; }
  };
  const fakeYoutube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' })
  };
  const originalFetch = global.fetch;
  global.fetch = async () => { requests += 1; return { ok: false, status: 402 }; };
  try {
    const worker = createSeoWorker({ store: fakeStore, youtube: fakeYoutube,
      env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'test-model' },
      logger: { error() {} } });
    await worker.run();
    assert.equal(finishError.retry, true);
    assert.match(finishError.message, /HTTP 402/);
    assert.ok(Date.parse(state.providerBlockedUntil) > Date.now());
    assert.match(state.providerError, /insufficient/);
    await worker.run();
    assert.equal(claims, 1);
    assert.equal(requests, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps a video retryable and pauses the queue after a transient Gemini 503', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, enabled: true };
  let claims = 0;
  let requests = 0;
  let finishError;
  const fakeStore = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => {
      claims += 1;
      return { videoId: 'video-1', claimToken: 'claim-1', source, context: {}, attempts: 3 };
    },
    finishSeoVideo: async (_videoId, _token, _pkg, error) => { finishError = error; }
  };
  const fakeYoutube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' })
  };
  const originalFetch = global.fetch;
  global.fetch = async () => { requests += 1; return { ok: false, status: 503 }; };
  try {
    const worker = createSeoWorker({ store: fakeStore, youtube: fakeYoutube,
      env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'gemini-3.6-flash',
        SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      logger: { error() {} } });
    await worker.run();
    assert.equal(finishError.retry, true);
    assert.match(finishError.message, /HTTP 503/);
    assert.ok(Date.parse(state.providerBlockedUntil) > Date.now());
    assert.match(state.providerError, /HTTP 503/);
    await worker.run();
    assert.equal(claims, 1);
    assert.equal(requests, 3);
  } finally {
    global.fetch = originalFetch;
  }
});
