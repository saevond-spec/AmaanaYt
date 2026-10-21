const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeVideo, videoIdFromUrl, analyzeGameplayFrames, validateGameplayAssessment } = require('../src/video-analysis');
const { createModelCircuitBreaker, validatePackage, normalizeContext } = require('../src/seo-package');
const { createSeoWorker } = require('../src/seo-worker');

const videoId = 'AbCdEfGhI12';
const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
const source = { title: 'NARAKA duel', description: 'A short match.', tags: ['NARAKA'],
  privacyStatus: 'public', durationSeconds: 190 };
const rawAnalysis = {
  summary: 'The player fights a close NARAKA duel and wins the last exchange.',
  spokenSummary: '', topics: ['NARAKA duel'],
  moments: [{ time: '02:00', detail: 'Final exchange' }, { time: '03:30', detail: 'Outside video' }],
  speakerTone: 'No spoken commentary', audience: 'NARAKA players', entities: ['NARAKA'],
  keywords: ['duel'], visualContext: 'Two fighters on a platform',
  primaryKeyword: 'NARAKA duel', secondaryKeywords: ['NARAKA combat'],
  category: 'Gaming', tags: ['NARAKA', 'duel']
};
const packageDraft = {
  primaryKeyword: 'NARAKA duel', titles: {
    search: ['NARAKA duel: Final Exchange', 'NARAKA duel: Close Fight', 'NARAKA duel: Match Tips'],
    curiosity: ['The Last Exchange Changed Everything', 'How Did This Duel End?', 'That Final Move Was So Close'],
    hybrid: ['NARAKA Duel: The Final Exchange', 'NARAKA Match With a Twist', 'NARAKA Combat: Last Fight']
  },
  thumbnails: [1, 2, 3].map(() => ({ visual: 'Fighters face off', overlay: 'FINAL MOVE',
    palette: 'Yellow and black', hook: 'Close fight' })),
  hook: 'NARAKA duel: Watch the opening, the close exchanges, and the final moment in this gameplay breakdown for players who enjoy tense one-on-one fights.',
  paragraphs: ['A NARAKA gameplay duel for players who enjoy close combat.',
    'Watch the match unfold and review its final exchange.'],
  tags: ['NARAKA duel', 'NARAKA', 'NARAKA gameplay', 'duel', 'combat', 'match', 'fighters',
    'final exchange'], hashtags: ['#NARAKA', '#Gameplay', '#Gaming'],
  pinnedComment: 'Which exchange stood out?', communityPost: 'A close NARAKA duel is up.', clipHooks: []
};

test('Gemini receives a public YouTube URL and returns bounded reviewable evidence', async () => {
  let request;
  const result = await analyzeVideo(videoUrl, { apiKey: 'test-key', model: 'gemini-3.8-flash',
    durationSeconds: 190, circuitBreaker: createModelCircuitBreaker(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [
        { thought: true, text: 'Do not use this' }, { text: JSON.stringify(rawAnalysis) }
      ] } }] }) };
    } });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(JSON.parse(request.options.body).contents[0].parts[1].file_data.file_uri, videoUrl);
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.deepEqual(result.moments, [{ time: '02:00', detail: 'Final exchange', approximate: true }]);
  assert.throws(() => videoIdFromUrl('https://not-youtube.example/watch?v=AbCdEfGhI12'), /YouTube watch URL/);
});

test('gameplay classification requires clear active gameplay in at least four of five sampled frames', () => {
  const good = validateGameplayAssessment({
    gameName: 'Example game',
    frames: Array.from({ length: 5 }, (_, index) => ({
      activeGameplay: index < 4, confidence: index < 4 ? 0.95 : 0.7,
      evidence: index < 4 ? 'Game world and active HUD are visible' : 'Facecam only'
    }))
  }, 5, 'gemini-3.8-flash');
  assert.equal(good.verified, true);
  assert.equal(good.activeGameplayFrames, 4);

  const weak = validateGameplayAssessment({
    frames: Array.from({ length: 5 }, (_, index) => ({
      activeGameplay: index < 3, confidence: 0.98, evidence: 'A game screen is visible'
    }))
  }, 5, 'gemini-3.8-flash');
  assert.equal(weak.verified, false);
});

test('Gemini gameplay screening sends sampled frames as images and returns a strict evidence result', async () => {
  const frames = Array.from({ length: 5 }, (_, index) => ({
    mimeType: 'image/jpeg', data: Buffer.from('frame-' + index).toString('base64')
  }));
  let requestBody;
  const result = await analyzeGameplayFrames(frames, {
    apiKey: 'test-key', model: 'gemini-3.8-flash',
    circuitBreaker: createModelCircuitBreaker(),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true, status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: JSON.stringify({
            gameName: 'Example game',
            frames: Array.from({ length: 5 }, () => ({
              activeGameplay: true, confidence: 0.94, evidence: 'Gameplay fills the frame'
            }))
          }) }] } }] };
        }
      };
    }
  });

  assert.equal(requestBody.contents[0].parts.length, 6);
  assert.equal(requestBody.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(result.verified, true);
  assert.equal(result.activeGameplayFrames, 5);
  assert.equal(result.gameName, 'Example game');
});

test('analysis retries 503 on a fallback model and honors short 429 Retry-After', async () => {
  const urls = [];
  const delays = [];
  const result = await analyzeVideo(videoUrl, { apiKey: 'test-key', model: 'gemini-3.8-flash',
    fallbackModels: ['gemini-3.5-flash-lite'], random: () => 0,
    circuitBreaker: createModelCircuitBreaker(), sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length === 1) return { ok: false, status: 503 };
      if (urls.length === 2) return { ok: false, status: 429, headers: { get: () => '20' } };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [
        { text: JSON.stringify(rawAnalysis) }
      ] } }] }) };
    } });
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.equal(urls.length, 3);
  assert.deepEqual(delays, [1000, 20000]);
});

test('analysis exposes bounded, redacted provider diagnostics for permanent 403 responses', async () => {
  await assert.rejects(analyzeVideo(videoUrl, {
    apiKey: 'test-key', model: 'gemini-3.8-flash',
    circuitBreaker: createModelCircuitBreaker(),
    fetchImpl: async () => ({
      ok: false, status: 403,
      async json() {
        return { error: { status: 'PERMISSION_DENIED',
          message: 'API key: hidden-provider-secret does not have permission for this video' } };
      }
    })
  }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.providerCode, 'PERMISSION_DENIED');
    assert.match(error.providerMessage, /does not have permission/);
    assert.doesNotMatch(error.providerMessage, /hidden-provider-secret/);
    return true;
  });
});

test('analysis supports the package prompt without promoting suggested moments to chapters', () => {
  const analysis = { ...rawAnalysis, moments: [{ time: '02:00', detail: 'Final exchange', approximate: true }] };
  const pkg = validatePackage(packageDraft, source, normalizeContext({}, 190), analysis);
  assert.equal(pkg.evidence.videoAnalysis, true);
  assert.deepEqual(pkg.chapters, []);
  assert.ok(pkg.missingEvidence.some((item) => /verified chapter markers/.test(item)));
  assert.ok(!pkg.missingEvidence.some((item) => /Script or key takeaways/.test(item)));
});

test('worker caches public video analysis and reuses it on regeneration', async () => {
  let cached = null;
  let calls = { analysis: 0, package: 0 };
  let claimed = 0;
  const finished = [];
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', recentAt: new Date().toISOString(),
      completed: true, viewPriorityScanVersion: 1, enabled: true }),
    saveSeoSyncState: async () => {},
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => claimed++ < 2
      ? { videoId, claimToken: `claim-${claimed}`, source, context: {}, attempts: 1 } : null,
    getVideoAnalysis: async () => cached,
    saveVideoAnalysis: async (_id, analysis, model) => { cached = { analysis, model }; },
    finishSeoVideo: async (_id, _token, pkg) => { finished.push(pkg); }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes(':generateContent')) {
      calls.analysis += 1;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [
        { text: JSON.stringify(rawAnalysis) }
      ] } }] }) };
    }
    calls.package += 1;
    const prompt = JSON.parse(options.body).messages[1].content;
    assert.equal(JSON.parse(prompt.slice(prompt.indexOf('DATA: ') + 6)).videoAnalysis.primaryKeyword,
      'NARAKA duel');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: {
      content: JSON.stringify(packageDraft) } }] }) };
  };
  try {
    const worker = createSeoWorker({ store, youtube, env: { SEO_AI_API_KEY: 'test-key',
      SEO_AI_MODEL: 'gemini-3.8-flash', SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      ENABLE_VIDEO_ANALYSIS: 'true', SEO_DAILY_LIMIT: '2' }, logger: { info() {}, warn() {}, error() {} } });
    await worker.run();
    assert.equal((await worker.status()).videoAnalysisEnabled, true);
  } finally { global.fetch = previousFetch; }
  assert.deepEqual(calls, { analysis: 1, package: 2 });
  assert.equal(finished.length, 2);
  assert.equal(finished[0].evidence.videoAnalysis, true);
  assert.equal(cached.model, 'gemini-3.8-flash');
});

test('analysis 503 pauses only analysis while metadata SEO generation continues', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, viewPriorityScanVersion: 1, enabled: true };
  let claimed = 0;
  let nativeCalls = 0;
  const finished = [];
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => claimed++ < 2
      ? { videoId, claimToken: `claim-${claimed}`, source, context: {}, attempts: 1 } : null,
    getVideoAnalysis: async () => null,
    saveVideoAnalysis: async () => assert.fail('failed analysis must not be cached'),
    finishSeoVideo: async (_id, _token, pkg) => { finished.push(pkg); }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes(':generateContent')) { nativeCalls += 1; return { ok: false, status: 503 }; }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: {
      content: JSON.stringify(packageDraft) } }] }) };
  };
  try {
    const worker = createSeoWorker({ store, youtube, env: { SEO_AI_API_KEY: 'test-key',
      SEO_AI_MODEL: 'gemini-3.8-flash', SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      ENABLE_VIDEO_ANALYSIS: 'true', SEO_DAILY_LIMIT: '2' }, sleep: async () => {},
    logger: { info() {}, warn() {}, error() {} } });
    await worker.run();
  } finally { global.fetch = previousFetch; }
  assert.equal(nativeCalls, 3);
  assert.equal(finished.length, 2);
  assert.ok(finished.every((pkg) => pkg.evidence.videoAnalysis === false));
  assert.ok(Date.parse(state.videoAnalysisBlockedUntil) > Date.now());
  assert.equal(state.providerBlockedUntil, undefined);
});

test('permanent video-analysis failures are cooled down per video instead of requeued every scan', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, viewPriorityScanVersion: 1, enabled: true };
  let claims = 0;
  let failureRecorded = false;
  let analysisCalls = 0;
  const failures = [];
  const finished = [];
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => {
      if (claims >= 2) return null;
      claims += 1;
      return { videoId, claimToken: 'claim-403-' + claims, source, context: {}, attempts: claims };
    },
    getVideoAnalysis: async () => null,
    getVideoAnalysisFailure: async () => failureRecorded
      ? { status: 403, retryAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } : null,
    markVideoAnalysisFailure: async (id, failure) => {
      failureRecorded = true;
      failures.push({ id, failure });
    },
    finishSeoVideo: async (_id, _token, pkg) => { finished.push(pkg); }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const worker = createSeoWorker({
    store, youtube,
    env: { SEO_AI_API_KEY: 'seo-key', SEO_AI_MODEL: 'test-model',
      VIDEO_ANALYSIS_API_KEY: 'analysis-key', ENABLE_VIDEO_ANALYSIS: 'true' },
    analyze: async () => {
      analysisCalls += 1;
      throw Object.assign(new Error('Video analysis provider returned HTTP 403'), {
        status: 403, providerCode: 'PERMISSION_DENIED', providerMessage: 'Access to this video was denied'
      });
    },
    generate: async () => packageDraft,
    logger: { info() {}, warn() {}, error() {} }
  });

  await worker.run();
  await worker.run();

  assert.equal(failures.length, 1);
  assert.equal(analysisCalls, 1, 'the persisted per-video failure suppresses another provider request');
  assert.equal(finished.length, 2, 'SEO metadata generation still runs while video analysis is cooling down');
  assert.equal(failures[0].id, videoId);
  assert.equal(failures[0].failure.status, 403);
  assert.equal(failures[0].failure.providerCode, 'PERMISSION_DENIED');
  assert.match(failures[0].failure.message, /Access to this video was denied/);
  assert.ok(Date.parse(failures[0].failure.retryAfter) - Date.now() > 23 * 60 * 60 * 1000);
  assert.equal(finished.length, 2, 'SEO metadata generation can continue without footage analysis');
  assert.equal(state.videoAnalysisBlockedUntil, undefined, 'one video permission failure must not block other videos');
});

test('a shared Gemini 429 pauses both analysis and SEO requests for the run', async () => {
  let state = { channelId: 'channel-1', recentAt: new Date().toISOString(),
    completed: true, viewPriorityScanVersion: 1, enabled: true };
  let claimed = false;
  let seoCalls = 0;
  let completion = null;
  const store = {
    getSeoSyncState: async () => state,
    saveSeoSyncState: async (next) => { state = next; },
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => claimed ? null : (claimed = true, {
      videoId, claimToken: 'claim-429', source, context: {}, attempts: 1
    }),
    getVideoAnalysis: async () => null,
    finishSeoVideo: async (_id, _token, pkg, error) => { completion = { pkg, error }; }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const worker = createSeoWorker({
    store, youtube,
    env: { SEO_AI_API_KEY: 'shared-key', SEO_AI_MODEL: 'gemini-3.8-flash',
      SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      VIDEO_ANALYSIS_API_KEY: 'analysis-key', ENABLE_VIDEO_ANALYSIS: 'true' },
    analyze: async () => {
      throw Object.assign(new Error('Gemini rate limit'), {
        status: 429, retryAfterPresent: true, retryAfterMs: 60000
      });
    },
    generate: async () => { seoCalls += 1; return packageDraft; },
    logger: { info() {}, warn() {}, error() {} }
  });

  await worker.run();

  assert.equal(seoCalls, 0, 'the shared Gemini project must not receive a second request after 429');
  assert.equal(completion.pkg, null);
  assert.equal(completion.error.retry, true);
  assert.ok(Date.parse(state.videoAnalysisBlockedUntil) > Date.now());
  assert.ok(Date.parse(state.providerBlockedUntil) > Date.now());
});

test('private uploads skip YouTube URL analysis', async () => {
  let claimed = false;
  let nativeCalls = 0;
  let generated;
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', recentAt: new Date().toISOString(),
      completed: true, viewPriorityScanVersion: 1, enabled: true }),
    saveSeoSyncState: async () => {},
    seoCounts: async () => ({ attemptedToday: 0 }),
    claimSeoVideo: async () => claimed ? null : (claimed = true, {
      videoId, claimToken: 'claim', source: { ...source, privacyStatus: 'private' }, context: {}, attempts: 1 }),
    getVideoAnalysis: async () => assert.fail('private video should not be checked for cached analysis'),
    finishSeoVideo: async (_id, _token, pkg) => { generated = pkg; }
  };
  const youtube = { isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner' }) };
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes(':generateContent')) nativeCalls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: {
      content: JSON.stringify(packageDraft) } }] }) };
  };
  try {
    const worker = createSeoWorker({ store, youtube, env: { SEO_AI_API_KEY: 'test-key',
      SEO_AI_MODEL: 'gemini-3.8-flash', SEO_AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      ENABLE_VIDEO_ANALYSIS: 'true', SEO_DAILY_LIMIT: '1' }, logger: { info() {}, warn() {}, error() {} } });
    await worker.run();
  } finally { global.fetch = previousFetch; }
  assert.equal(nativeCalls, 0);
  assert.equal(generated.evidence.videoAnalysis, false);
});
