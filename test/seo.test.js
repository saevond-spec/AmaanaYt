const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContext, normalizeSource, validatePackage, generatePackage,
  descriptionChapters, retryAfterDetails, createModelCircuitBreaker } = require('../src/seo-package');
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
    'opening strategy', 'final fight'],
  hashtags: ['#NARAKA', '#Gameplay', '#Gaming'],
  pinnedComment: 'Which round stood out to you most?',
  communityPost: 'Watch the final fight in my latest match.',
  clipHooks: ['The final fight starts here.', 'Watch the reaction at the end.']
};

test('normalizes text and spoken-audio languages separately', () => {
  const normalized = normalizeSource({
    snippet: { title: 'Audio metadata', description: 'English description',
      defaultLanguage: 'en', defaultAudioLanguage: 'ja' },
    contentDetails: { duration: 'PT30S' },
    status: { privacyStatus: 'public' }
  });
  assert.equal(normalized.defaultLanguage, 'en');
  assert.equal(normalized.defaultAudioLanguage, 'ja');
});

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

test('shorter truthful hooks and focused tags pass, and market provenance is recorded', () => {
  const pkg = validatePackage({ ...generated,
    hook: 'NARAKA BLADEPOINT guide with a final fight from this match.',
    tags: ['NARAKA', 'BLADEPOINT gameplay', 'final fight']
  }, source, context, { summary: 'Observed match' }, {
    observedAt: '2026-10-02T12:00:00Z', samples: [{ id: 'public-1' }]
  });
  assert.equal(pkg.evidence.marketSampleSize, 1);
  assert.equal(pkg.evidence.marketObservedAt, '2026-10-02T12:00:00Z');
  assert.equal(pkg.tags.length, 3);
});

test('tag output caps overlong provider lists and restores the exact primary keyword', () => {
  const omittedKeyword = validatePackage({ ...generated,
    tags: ['NARAKA gameplay', 'final fight', 'match guide']
  }, source, context);
  assert.equal(omittedKeyword.tags[0], keyword);
  const differentlyCasedKeyword = validatePackage({ ...generated,
    tags: ['naraka bladepoint guide', 'final fight', 'match guide']
  }, source, context);
  assert.equal(differentlyCasedKeyword.tags[0], keyword);

  const candidates = [keyword, ...Array.from({ length: 14 }, (_value, index) => 'NARAKA term ' + index)];
  const pkg = validatePackage({ ...generated, tags: candidates }, source, context);
  assert.deepEqual(pkg.tags, candidates.slice(0, 8));
  assert.ok(pkg.tags.join(',').length <= 450);

  const longCandidates = [keyword, ...Array(14).fill('x'.repeat(60))];
  const trimmed = validatePackage({ ...generated, tags: longCandidates }, source, context);
  assert.ok(trimmed.tags.length <= 8);
  assert.ok(trimmed.tags.join(',').length <= 450);
  assert.throws(() => validatePackage({ ...generated, tags: Array(31).fill('NARAKA') }, source, context),
    /3–30 focused tag candidates/);
});

test('two-year provider tag-drift simulation keeps all 730 packages valid and focused', () => {
  let generatedPackages = 0;
  let trimmedPackages = 0;
  for (let day = 0; day < 730; day += 1) {
    const candidateCount = 3 + (day % 13);
    const candidates = [];
    if (day % 11 !== 0) candidates.push(keyword);
    for (let index = 0; candidates.length < candidateCount; index += 1) {
      candidates.push(day % 17 === 0 ? 'x'.repeat(60) : 'NARAKA term ' + day + '-' + index);
    }
    const pkg = validatePackage({ ...generated, tags: candidates }, source, context);
    assert.ok(pkg.tags.length >= 3 && pkg.tags.length <= 8);
    assert.equal(pkg.tags[0], keyword);
    assert.ok(pkg.tags.join(',').length <= 450);
    generatedPackages += 1;
    if (candidateCount > 8 || pkg.tags.length < candidateCount || day % 11 === 0) trimmedPackages += 1;
  }
  assert.equal(generatedPackages, 730);
  assert.ok(trimmedPackages > 0);
});

test('live market evidence reaches the prompt as observations without replacing video facts', async () => {
  let prompt;
  await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'test-model',
    marketEvidence: { game: 'NARAKA: BLADEPOINT', query: 'NARAKA: BLADEPOINT gameplay',
      observedAt: '2026-10-02T12:00:00Z', windowDays: 7,
      samples: [{ id: 'sample-1', title: 'NARAKA parry', publishedAt: '2026-10-01T00:00:00Z',
        viewCount: 400, estimatedViewsPerDay: 400 }] },
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[1].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) };
    }
  });
  assert.match(prompt, /Market examples are recent public videos, not search demand estimates/);
  assert.match(prompt, /NARAKA parry/);
  assert.match(prompt, /estimatedViewsPerDay/);
  assert.match(prompt, /Opening, first round, final fight/);
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
    circuitBreaker: createModelCircuitBreaker(),
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
    circuitBreaker: createModelCircuitBreaker(),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return requests.length < 3 ? { ok: false, status: 503 } : {
        ok: true, json: async () => ({ candidates: [{ content: { parts: [
          { thought: true, text: 'Do not parse this as JSON' }, { text: JSON.stringify(generated) }
        ] } }] })
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

test('recovers on a second native model after transient Gemini 503s', async () => {
  const requests = [];
  const delays = [];
  const pkg = await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.5-flash-lite',
    secondaryNativeModel: 'gemini-3.1-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    circuitBreaker: createModelCircuitBreaker(), random: () => 0.5,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async (url) => {
      requests.push(String(url));
      return requests.length < 6 ? { ok: false, status: 503 } : {
        ok: true, json: async () => ({ candidates: [{ content: { parts: [
          { text: JSON.stringify(generated) }
        ] } }] })
      };
    }
  });
  assert.deepEqual(requests.slice(3), Array(3).fill(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent'));
  assert.deepEqual(delays, [1500, 5500, 15500]);
  assert.equal(pkg.titles.search.length, 3);
});

test('uses the current stable Gemini model after older models return 503', async () => {
  const requests = [];
  const pkg = await generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'gemini-3.6-flash', fallbackModel: 'gemini-3.5-flash-lite',
    secondaryNativeModel: 'gemini-3.1-flash-lite', finalNativeModel: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    circuitBreaker: createModelCircuitBreaker(),
    sleep: async () => {},
    fetchImpl: async (url) => {
      requests.push(String(url));
      return requests.length < 7 ? { ok: false, status: 503 } : {
        ok: true, json: async () => ({ candidates: [{ content: { parts: [
          { text: JSON.stringify(generated) }
        ] } }] })
      };
    }
  });
  assert.equal(requests[6],
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(pkg.titles.search.length, 3);
});

test('parses Retry-After seconds and dates, with a 60 second request default', () => {
  const response = (value) => ({ headers: { get: () => value } });
  assert.deepEqual(retryAfterDetails(response('42')), { retryAfterPresent: true, retryAfterMs: 42000 });
  assert.deepEqual(retryAfterDetails(response('Mon, 28 Sep 2026 16:02:00 GMT'),
    () => Date.parse('Mon, 28 Sep 2026 16:00:00 GMT')),
  { retryAfterPresent: true, retryAfterMs: 120000 });
  assert.deepEqual(retryAfterDetails(response(null)), { retryAfterPresent: false, retryAfterMs: 60000 });
});

test('exposes provider 429 Retry-After and machine-readable quota code', async () => {
  const delays = [];
  let requests = 0;
  await assert.rejects(generatePackage(source, context, {
    apiKey: 'unit-test-key', model: 'rate-test', circuitBreaker: createModelCircuitBreaker(),
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => { requests += 1; return { ok: false, status: 429,
      headers: { get: (header) => header === 'retry-after' ? '25' : null },
      json: async () => ({ error: { code: 'rate_limit_exceeded' } }) }; }
  }), (error) => error.status === 429 && error.retryAfterPresent &&
    error.retryAfterMs === 25000 && error.code === 'rate_limit_exceeded');
  assert.equal(requests, 2);
  assert.deepEqual(delays, [25000]);
});

test('429 without a header retries once after 60 seconds; long headers defer to the queue', async () => {
  const delays = [];
  let requests = 0;
  const options = { apiKey: 'unit-test-key', model: 'rate-default-test',
    circuitBreaker: createModelCircuitBreaker(), sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => ++requests === 1 ? { ok: false, status: 429,
      headers: { get: () => null } } : { ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) } };
  const pkg = await generatePackage(source, context, options);
  assert.equal(pkg.primaryKeyword, keyword);
  assert.equal(requests, 2);
  assert.deepEqual(delays, [60000]);
  requests = 0;
  await assert.rejects(generatePackage(source, context, {
    ...options, fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 429, headers: { get: () => '120' }, json: async () => null };
    }
  }), (error) => error.retryAfterMs === 120000 && error.retryAfterPresent);
  assert.equal(requests, 1);
  assert.deepEqual(delays, [60000]);
});

test('opens a model circuit after three 503s and closes it after 30 minutes', async () => {
  let now = Date.now();
  let requests = 0;
  const circuitBreaker = createModelCircuitBreaker({ now: () => now });
  const options = {
    apiKey: 'unit-test-key', model: 'isolated-test', circuitBreaker,
    fetchImpl: async () => { requests += 1; return { ok: false, status: 503 }; }
  };
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(generatePackage(source, context, options), (error) => error.status === 503);
  }
  assert.equal(requests, 3);
  now += 30 * 60 * 1000 + 1;
  await assert.rejects(generatePackage(source, context, options), /HTTP 503/);
  assert.equal(requests, 4);
});

test('uses SEO_AI_TIMEOUT_MS for model request signals', async () => {
  const originalTimeout = AbortSignal.timeout;
  const durations = [];
  AbortSignal.timeout = (ms) => { durations.push(ms); return originalTimeout(ms); };
  try {
    await generatePackage(source, context, { apiKey: 'unit-test-key', model: 'timeout-test',
      timeoutMs: '180000', circuitBreaker: createModelCircuitBreaker(),
      fetchImpl: async () => ({ ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) }) });
    assert.deepEqual(durations, [180000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('worker uses Retry-After on 429 and pauses 60 minutes when absent', async () => {
  const originalFetch = global.fetch;
  try {
    for (const header of ['45', null]) {
      let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
        completed: true, enabled: true };
      const fakeStore = {
        getSeoSyncState: async () => state,
        saveSeoSyncState: async (next) => { state = next; },
        seoCounts: async () => ({ attemptedToday: 0 }),
        claimSeoVideo: async () => ({ videoId: 'rate-video', claimToken: 'claim', source, context: {}, attempts: 1 }),
        finishSeoVideo: async () => {}
      };
      const youtube = { isConnected: async () => true,
        ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
      global.fetch = async () => ({ ok: false, status: 429,
        headers: { get: (name) => name === 'retry-after' ? header : null },
        json: async () => ({ error: { code: 'rate_limit_exceeded' } }) });
      const worker = createSeoWorker({ store: fakeStore, youtube,
        env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'rate-worker' },
        sleep: async () => {}, logger: { error() {} } });
      await worker.run();
      const pause = Date.parse(state.providerBlockedUntil) - Date.now();
      assert.ok(Math.abs(pause - (header ? 45000 : 60 * 60 * 1000)) < 2000);
      assert.equal(state.consecutive503s, 0);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('worker grows consecutive 503 pauses to 120 minutes', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, enabled: true };
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => ({ videoId: 'overload-video', claimToken: 'claim', source, context: {}, attempts: 1 }),
    finishSeoVideo: async () => {}
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    const worker = createSeoWorker({ store, youtube,
      env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'overload-worker' }, logger: { error() {} } });
    for (const [index, expectedMinutes] of [30, 60, 120, 120].entries()) {
      state.providerBlockedUntil = null;
      await worker.run();
      assert.equal(state.consecutive503s, index + 1);
      assert.ok(Math.abs(Date.parse(state.providerBlockedUntil) - Date.now() - expectedMinutes * 60000) < 2000);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('worker can process more than five jobs in one run with default budget 200', async () => {
  let claimed = 0;
  let finished = 0;
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', recentAt: new Date().toISOString(),
      completed: true, enabled: true }),
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => claimed++ < 6
      ? { videoId: `video-${claimed}`, claimToken: 'claim', source, context: {}, attempts: 1 } : null,
    finishSeoVideo: async () => { finished += 1; }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }) });
  try {
    const worker = createSeoWorker({ store, youtube,
      env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'batch-worker' }, logger: { info() {}, error() {} } });
    assert.equal((await worker.status()).dailyLimit, 200);
    await worker.run();
    assert.equal(finished, 6);
  } finally {
    global.fetch = originalFetch;
  }
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
      sleep: async () => {},
      logger: { error() {} } });
    await worker.run();
    assert.equal(finishError.retry, true);
    assert.match(finishError.message, /HTTP 503/);
    assert.ok(Date.parse(state.providerBlockedUntil) > Date.now());
    assert.match(state.providerError, /HTTP 503/);
    await worker.run();
    assert.equal(claims, 1);
    assert.equal(requests, 7);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a new fallback gets one probe during cooldown, then respects the pause', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, enabled: true,
    providerBlockedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    providerProbeTag: 'final:gemini-3.1-flash-lite' };
  let claims = 0;
  const fakeStore = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => {
      claims += 1;
      return { videoId: 'video-1', claimToken: 'claim-1', source, context: {}, attempts: 3 };
    },
    finishSeoVideo: async () => {}
  };
  const fakeYoutube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' })
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    const worker = createSeoWorker({ store: fakeStore, youtube: fakeYoutube,
      env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'gemini-3.6-flash',
        SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      sleep: async () => {}, logger: { error() {} } });
    await worker.run();
    assert.equal(state.providerProbeTag, 'final:gemini-3.8-flash');
    assert.equal(claims, 1);
    await worker.run();
    assert.equal(claims, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('analysis backfill queues a bounded batch of public videos in one run', async () => {
  const candidates = Array.from({ length: 8 }, (_value, index) => ({
    videoId: 'public-' + index, context: { takeaways: '' }
  }));
  const queued = [];
  let requestedLimit = 0;
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', recentAt: new Date().toISOString(),
      completed: true, enabled: true }),
    seoCounts: async () => ({ attemptedToday: 0 }),
    listSeoNeedsAnalysis: async (limit) => { requestedLimit = limit; return candidates.slice(0, limit); },
    updateSeoContext: async (id) => { queued.push(id); return true; },
    claimSeoVideo: async () => null
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const worker = createSeoWorker({ store, youtube, env: {
    SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'batch-analysis',
    ENABLE_VIDEO_ANALYSIS: 'true', VIDEO_ANALYSIS_API_KEY: 'test-video-key',
    SEO_ANALYSIS_BATCH_SIZE: '5'
  }, logger: { info() {}, error() {} } });
  await worker.run();
  assert.equal(requestedLimit, 5);
  assert.deepEqual(queued, ['public-0', 'public-1', 'public-2', 'public-3', 'public-4']);
});

test('five-year queue simulation drains the active backlog and requeues only legacy tag failures once', async () => {
  const days = 365 * 5;
  let currentDay = 0;
  let tagRecoveryDone = false;
  let recoveryCalls = 0;
  let requeuedTotal = 0;
  const rows = [];
  const makeRow = (index, status, error = null, attempts = 0) => ({
    videoId: 'video-' + index,
    source: { ...source, title: 'NARAKA BLADEPOINT match ' + index, privacyStatus: 'public' },
    context,
    status, error, attempts, nextAttemptDay: status === 'retry' ? 1 : 0,
    claimedDay: status === 'generating' ? -1 : null,
    lastAttemptDay: null, claimToken: null, package: null
  });
  for (let index = 0; index < 2405; index += 1) rows.push(makeRow(index, 'queued'));
  for (let index = 0; index < 32; index += 1) rows.push(makeRow(2405 + index, 'retry', 'temporary provider issue', 1));
  rows.push(makeRow(2437, 'generating'));
  for (let index = 0; index < 130; index += 1) rows.push(makeRow(2438 + index, 'needs_review'));
  rows.push(makeRow(2568, 'failed', 'Expected 10–15 tags', 3));
  rows.push(makeRow(2569, 'failed', 'Tags exceed the recommended combined length', 3));
  rows.push(makeRow(2570, 'failed', 'Tags must include the exact primary keyword', 3));
  rows.push(makeRow(2571, 'failed', 'Invalid JSON output', 3));
  for (const [index, privacyStatus] of [[2572, 'private'], [2573, 'unlisted']]) {
    const row = makeRow(index, 'failed', 'Tags exceed the recommended combined length', 3);
    row.source = { ...row.source, privacyStatus };
    rows.push(row);
  }

  let sync = { channelId: 'channel-1', recentAt: '2099-01-01T00:00:00.000Z',
    completed: true, enabled: true };
  const store = {
    getSeoSyncState: async () => sync,
    saveSeoSyncState: async (next) => { sync = next; },
    requeueLegacySeoTagFailures: async () => {
      recoveryCalls += 1;
      if (tagRecoveryDone) return 0;
      tagRecoveryDone = true;
      let count = 0;
      for (const row of rows) {
        if (row.status === 'failed' && row.source.privacyStatus === 'public' &&
            (/^Expected 10.*15.*tag/i.test(row.error || '') ||
             /^Tags exceed the recommended combined length/i.test(row.error || '') ||
             /^Tags must include the exact primary keyword/i.test(row.error || ''))) {
          row.status = 'queued';
          row.error = null;
          row.attempts = 0;
          row.package = null;
          row.nextAttemptDay = currentDay;
          count += 1;
        }
      }
      requeuedTotal += count;
      return count;
    },
    seoCounts: async () => {
      const statuses = {};
      for (const row of rows) statuses[row.status] = (statuses[row.status] || 0) + 1;
      return { statuses, attemptedToday: rows.filter((row) => row.lastAttemptDay === currentDay).length };
    },
    claimSeoVideo: async () => {
      const row = rows.find((candidate) => candidate.status === 'queued' ||
        candidate.status === 'retry' && candidate.nextAttemptDay <= currentDay ||
        candidate.status === 'generating' && candidate.claimedDay < currentDay);
      if (!row) return null;
      row.status = 'generating';
      row.attempts += 1;
      row.claimedDay = currentDay;
      row.lastAttemptDay = currentDay;
      row.claimToken = row.videoId + '-' + row.attempts;
      return { videoId: row.videoId, source: row.source, context: row.context,
        attempts: row.attempts, claimToken: row.claimToken };
    },
    finishSeoVideo: async (videoId, claimToken, generatedPackage, error) => {
      const row = rows.find((candidate) => candidate.videoId === videoId);
      assert.equal(row.claimToken, claimToken);
      row.claimToken = null;
      row.claimedDay = null;
      if (generatedPackage) {
        row.package = generatedPackage;
        row.status = generatedPackage.missingEvidence.length ? 'needs_review' : 'ready';
        row.error = null;
      } else {
        row.package = null;
        row.status = error.retry ? 'retry' : 'failed';
        row.error = error.message;
        if (error.retry) row.nextAttemptDay = currentDay + 1;
      }
    }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const createWorker = () => createSeoWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'test-key', SEO_AI_MODEL: 'two-year-simulation',
      SEO_DAILY_LIMIT: '200' }, logger: { info() {}, warn() {}, error() {} },
    generate: async (videoSource, videoContext) => {
      const index = Number(videoSource.title.match(/\d+$/)?.[0] || 0);
      const candidateCount = 3 + (index % 13);
      const candidates = [];
      if (index % 11 !== 0) candidates.push(keyword);
      for (let tagIndex = 0; candidates.length < candidateCount; tagIndex += 1) {
        candidates.push('NARAKA term ' + index + '-' + tagIndex);
      }
      return validatePackage({ ...generated, tags: candidates }, videoSource, videoContext,
        { summary: 'Observed gameplay from this video' });
    }
  });
  let worker = createWorker();
  let drainedAfterDay = null;
  for (let day = 0; day < days; day += 1) {
    currentDay = day;
    if (day > 0 && day % 365 === 0) worker = createWorker();
    await worker.run();
    const active = rows.filter((row) => ['queued', 'retry', 'generating'].includes(row.status)).length;
    if (drainedAfterDay === null && active === 0) drainedAfterDay = day + 1;
  }

  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  assert.equal(rows.length, 2574);
  assert.equal(recoveryCalls, 5);
  assert.equal(requeuedTotal, 3);
  assert.equal(drainedAfterDay, 13);
  assert.equal(counts.ready, 2441);
  assert.equal(counts.needs_review, 130);
  assert.equal(counts.failed, 3);
  assert.equal(counts.queued || 0, 0);
  assert.equal(counts.retry || 0, 0);
  assert.equal(counts.generating || 0, 0);
  assert.ok(rows.filter((row) => !['video-2572', 'video-2573'].includes(row.videoId))
    .every((row) => row.source.privacyStatus === 'public'));
  assert.equal(rows.find((row) => row.videoId === 'video-2572').status, 'failed');
  assert.equal(rows.find((row) => row.videoId === 'video-2573').status, 'failed');
});

test('restarting a catalog backfill requeues unmatched playlist results', async () => {
  let state = { cursor: 'older-page', completed: true, recentAt: '2026-10-03T00:00:00.000Z',
    enabled: true, providerBlockedUntil: '2026-10-04T00:00:00.000Z', providerError: 'quotaExceeded',
    playlistCoverageAudit: { complete: true, missingCount: 0 } };
  let resetCalls = 0;
  let saved;
  const log = [];
  const store = {
    getSeoSyncState: async () => state,
    resetSeoPlaylistResults: async () => { resetCalls += 1; return 7; },
    saveSeoSyncState: async (next) => { saved = next; state = next; }
  };
  const worker = createSeoWorker({ store, youtube: {}, env: {},
    logger: { info: (message) => log.push(message) } });

  const updated = await worker.setBackfill(false, true);

  assert.equal(resetCalls, 1);
  assert.equal(saved.cursor, null);
  assert.equal(saved.completed, false);
  assert.equal(saved.recentAt, null);
  assert.equal(saved.playlistCoverageAudit, null);
  assert.equal(saved.enabled, false);
  assert.equal(saved.providerBlockedUntil, '2026-10-04T00:00:00.000Z');
  assert.equal(saved.providerError, 'quotaExceeded');
  assert.equal(updated, saved);
  assert.deepEqual(log, ['Requeued 7 videos for automatic playlist matching']);
});


test('automatically audits completed catalog coverage and retries repairs daily', async () => {
  let state = { channelId: 'channel-1', channelTitle: 'Owner', cursor: null, completed: true,
    recentAt: new Date().toISOString(), enabled: true };
  let auditCalls = 0;
  let assignmentCalls = 0;
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; }
  };
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' })
  };
  const playlistAuto = {
    enabled: true,
    assignCatalogBacklog: async () => { assignmentCalls += 1; return { attempted: 0, assigned: 0 }; },
    reconcilePlaylistCoverage: async () => {
      auditCalls += 1;
      return {
        channelId: 'channel-1', channelTitle: 'Owner', checkedAt: new Date().toISOString(),
        catalogPages: 52, catalogCount: 2572, playlistCount: 18, membershipCount: 2570,
        coveredCount: 2570, publicCoverageCount: 2100, missingCount: 2,
        failedPlaylists: [], complete: true, catalogScanComplete: true, requeuedCount: 2
      };
    }
  };
  const worker = createSeoWorker({ store, youtube, playlistAuto, env: {},
    logger: { info() {}, warn() {} } });

  await worker.run();

  assert.equal(auditCalls, 1);
  assert.equal(assignmentCalls, 2);
  assert.equal(state.playlistCoverageAudit.catalogCount, 2572);
  assert.equal(state.playlistCoverageAudit.coveredCount, 2570);
  assert.equal(state.playlistCoverageAudit.missingCount, 2);
  assert.equal(state.playlistCoverageAudit.requeuedCount, 2);

  await worker.run();

  assert.equal(auditCalls, 1);
  assert.equal(assignmentCalls, 3);
});

test('default catalog scan processes twenty older uploads per run', async () => {
  let state = { cursor: 'page-1', completed: false, enabled: true,
    recentAt: new Date().toISOString() };
  const pages = [];
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    upsertSeoVideo: async () => {}
  };
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' }),
    uploadsPage: async (_playlistId, cursor) => {
      pages.push(cursor);
      const page = Number(cursor.split('-')[1]);
      return { ids: [], nextPageToken: page < 30 ? `page-${page + 1}` : null };
    },
    videoMetadata: async () => []
  };
  const worker = createSeoWorker({ store, youtube, env: {}, logger: { info() {} } });

  await worker.run();

  assert.equal(pages.length, 20);
  assert.equal(pages[0], 'page-1');
  assert.equal(pages.at(-1), 'page-20');
  assert.equal(state.cursor, 'page-21');
  assert.equal(state.completed, false);
});

test('catalog scan processes a bounded batch of older uploads per run', async () => {
  let state = { cursor: null, completed: false, enabled: true };
  const pages = [];
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    upsertSeoVideo: async () => {}
  };
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' }),
    uploadsPage: async (_playlistId, cursor) => {
      pages.push(cursor || 'recent');
      const sequence = ['page-1', 'page-2', 'page-3', 'page-4'];
      const current = cursor ? sequence.indexOf(cursor) : -1;
      return { ids: [], nextPageToken: sequence[current + 1] || null };
    },
    videoMetadata: async () => []
  };
  const worker = createSeoWorker({ store, youtube, env: { SEO_CATALOG_PAGES_PER_RUN: '2' } });

  await worker.run();

  assert.deepEqual(pages, ['recent', 'page-1', 'page-2']);
  assert.equal(state.cursor, 'page-3');
  assert.equal(state.completed, false);
});
