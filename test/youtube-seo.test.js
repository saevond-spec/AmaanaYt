const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');
const store = require('../src/store');
const youtube = require('../src/youtube');

test('video metadata update sends only snippet, retains category/language, and uses the current ETag', async (t) => {
  const oldYoutube = google.youtube;
  const oldTokens = store.getTokens;
  const oldBaseUrl = process.env.BASE_URL;
  t.after(() => {
    google.youtube = oldYoutube;
    store.getTokens = oldTokens;
    process.env.BASE_URL = oldBaseUrl;
  });
  process.env.BASE_URL = 'https://amaana.example.test';
  store.getTokens = async () => ({ access_token: 'unit-test', expiry_date: Date.now() + 3600000 });
  let request;
  google.youtube = () => ({
    videos: { update: async (params, options) => {
      request = { params, options };
      return { data: { id: 'abcdefghijk', snippet: params.requestBody.snippet } };
    } }
  });

  const current = {
    etag: '"etag-before-change"',
    snippet: { title: 'Before', description: 'Description', tags: ['old'],
      categoryId: '20', defaultLanguage: 'ja', channelId: 'channel-1' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
  };
  await assert.rejects(youtube.updateVideoSeo('abcdefghijk', { ...current, etag: undefined },
    { title: 'After', description: 'Better description', tags: ['new'] }), /video version/);
  assert.equal(request, undefined);
  await youtube.updateVideoSeo('abcdefghijk', current, {
    title: 'After', description: 'Better description', tags: ['new']
  });
  assert.deepEqual(request.params.part, ['snippet']);
  assert.deepEqual(request.params.requestBody, {
    id: 'abcdefghijk',
    snippet: { title: 'After', description: 'Better description', tags: ['new'],
      categoryId: '20', defaultLanguage: 'ja' }
  });
  assert.equal(request.options.headers['If-Match'], current.etag);
  assert.equal(Object.hasOwn(request.params.requestBody, 'status'), false);
});

test('channel update retains supported branding fields and rejects a stale channel snapshot', async (t) => {
  const oldYoutube = google.youtube;
  const oldTokens = store.getTokens;
  const oldBaseUrl = process.env.BASE_URL;
  t.after(() => {
    google.youtube = oldYoutube;
    store.getTokens = oldTokens;
    process.env.BASE_URL = oldBaseUrl;
  });
  process.env.BASE_URL = 'https://amaana.example.test';
  store.getTokens = async () => ({ access_token: 'unit-test', expiry_date: Date.now() + 3600000 });
  let request;
  let includeEtag = true;
  google.youtube = () => ({
    channels: {
      list: async () => ({ data: { items: [{
        id: 'channel-1', ...(includeEtag ? { etag: '"channel-etag"' } : {}),
        snippet: { title: 'Saevond', description: 'Existing channel identity' },
        brandingSettings: { channel: {
          title: 'Saevond', description: 'Existing channel identity', keywords: 'gaming',
          country: 'US', defaultLanguage: 'en', unsubscribedTrailer: 'abcdefghijk'
        } },
        contentDetails: { relatedPlaylists: { uploads: 'uploads-1' } }
      }] } }),
      update: async (params, options) => { request = { params, options }; return { data: {} }; }
    }
  });
  const current = await youtube.channelSeo();
  includeEtag = false;
  await assert.rejects(youtube.updateChannelSeo(current,
    { description: current.description, keywords: 'gaming new' }), /channel version/);
  assert.equal(request, undefined);
  includeEtag = true;
  await assert.rejects(youtube.updateChannelSeo({ ...current, keywords: 'stale' },
    { description: current.description, keywords: 'gaming new' }), /changed/);
  assert.equal(request, undefined);
  await youtube.updateChannelSeo(current, { description: current.description, keywords: 'gaming new' });
  assert.deepEqual(request.params.part, ['brandingSettings']);
  assert.deepEqual(request.params.requestBody, {
    id: 'channel-1',
    brandingSettings: { channel: {
      title: 'Saevond', description: 'Existing channel identity', keywords: 'gaming new',
      country: 'US', defaultLanguage: 'en', unsubscribedTrailer: 'abcdefghijk'
    } }
  });
  assert.equal(request.options.headers['If-Match'], '"channel-etag"');
});

test('public broadcast ads update only monetization details with the current version', async (t) => {
  const oldYoutube = google.youtube;
  const oldTokens = store.getTokens;
  const oldBaseUrl = process.env.BASE_URL;
  t.after(() => { google.youtube = oldYoutube; store.getTokens = oldTokens;
    process.env.BASE_URL = oldBaseUrl; });
  process.env.BASE_URL = 'https://amaana.example.test';
  store.getTokens = async () => ({ access_token: 'unit-test', expiry_date: Date.now() + 3600000 });
  let request;
  google.youtube = () => ({ liveBroadcasts: { update: async (params, options) => {
    request = { params, options };
    return { data: { monetizationDetails: { adsMonetizationStatus: 'on' } } };
  } } });
  const current = { id: 'live-1', etag: '"broadcast-etag"',
    snippet: { channelId: 'channel-1', scheduledStartTime: '2026-10-02T12:00:00Z' },
    status: { privacyStatus: 'public', lifeCycleStatus: 'live' },
    contentDetails: { monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 } },
    monetizationDetails: { adsMonetizationStatus: 'off', eligibleForAdsMonetization: true,
      cuepointSchedule: { enabled: true, ytOptimizedCuepointConfig: 'MEDIUM' } }
  };
  await assert.rejects(youtube.enablePublicBroadcastAds({ ...current,
    status: { privacyStatus: 'private', lifeCycleStatus: 'live' } }), /eligible public/);
  assert.equal(request, undefined);
  await youtube.enablePublicBroadcastAds(current);
  assert.deepEqual(request.params.part, ['monetizationDetails']);
  assert.equal(Object.hasOwn(request.params.requestBody, 'status'), false);
  assert.deepEqual(request.params.requestBody.monetizationDetails, {
    adsMonetizationStatus: 'on',
    cuepointSchedule: { enabled: true, ytOptimizedCuepointConfig: 'MEDIUM' }
  });
  assert.equal(request.options.headers['If-Match'], current.etag);
});

test('market search keeps only recently published public videos and their observed views', async (t) => {
  const oldYoutube = google.youtube;
  const oldTokens = store.getTokens;
  const oldBaseUrl = process.env.BASE_URL;
  t.after(() => { google.youtube = oldYoutube; store.getTokens = oldTokens;
    process.env.BASE_URL = oldBaseUrl; });
  process.env.BASE_URL = 'https://amaana.example.test';
  store.getTokens = async () => ({ access_token: 'unit-test', expiry_date: Date.now() + 3600000 });
  let query;
  google.youtube = () => ({
    search: { list: async (params) => {
      query = params;
      return { data: { items: [{ id: { videoId: 'public-1' } },
        { id: { videoId: 'private-1' } }, { id: { videoId: 'public-2' } }] } };
    } },
    videos: { list: async () => ({ data: { items: [
      { id: 'public-1', snippet: { title: 'Gameplay A', publishedAt: '2026-10-01T00:00:00Z', channelId: 'other' },
        statistics: { viewCount: '100' }, status: { privacyStatus: 'public' } },
      { id: 'private-1', snippet: { title: 'Hidden', publishedAt: '2026-10-01T00:00:00Z' },
        statistics: { viewCount: '9999' }, status: { privacyStatus: 'private' } },
      { id: 'public-2', snippet: { title: 'Gameplay B', publishedAt: '2026-10-01T00:00:00Z', channelId: 'other' },
        statistics: { viewCount: '500' }, status: { privacyStatus: 'public' } }
    ] } }) }
  });
  const items = await youtube.recentGameVideos('ARC Raiders', { now: Date.parse('2026-10-02T12:00:00Z') });
  assert.equal(query.q, 'ARC Raiders gameplay');
  assert.equal(query.type, 'video');
  assert.equal(query.publishedAfter, '2026-09-25T12:00:00.000Z');
  assert.deepEqual(items.map((item) => item.id), ['public-2', 'public-1']);
});
