const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeVideo, videoIdFromUrl } = require('../src/video-analysis');
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
    'final exchange', 'one on one', 'gameplay'], hashtags: ['#NARAKA', '#Gameplay', '#Gaming'],
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
      completed: true, enabled: true }),
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
    completed: true, enabled: true };
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

test('private uploads skip YouTube URL analysis', async () => {
  let claimed = false;
  let nativeCalls = 0;
  let generated;
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', recentAt: new Date().toISOString(),
      completed: true, enabled: true }),
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
