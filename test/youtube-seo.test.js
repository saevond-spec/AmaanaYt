const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { google } = require('googleapis');
const store = require('../src/store');
const youtube = require('../src/youtube');

test('catalog metadata request includes statistics needed for view-count triage', async (t) => {
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
    videos: { list: async (params) => { request = params; return { data: { items: [] } }; } }
  });

  await youtube.videoMetadata(['abcdefghijk']);

  assert.deepEqual(request.part, ['snippet', 'status', 'contentDetails', 'statistics', 'localizations']);
  assert.match(request.fields, /statistics\(viewCount\)/);
  assert.match(request.fields, /localizations/);
});

test('video metadata update sends only writable snippet fields and uses the current ETag', async (t) => {
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
      categoryId: '20', defaultLanguage: 'ja', defaultAudioLanguage: 'en', channelId: 'channel-1' },
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
      categoryId: '20', defaultLanguage: 'ja', defaultAudioLanguage: 'en' }
  });
  assert.equal(request.options.headers['If-Match'], current.etag);
  assert.equal(Object.hasOwn(request.params.requestBody, 'status'), false);
});

test('owned upload pagination returns the requested page across YouTube upload-list pages', async (t) => {
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
  const ids = Array.from({ length: 60 }, (_, index) => String(index).padStart(11, '0'));
  const playlistCalls = [];
  google.youtube = () => ({
    channels: { list: async () => ({ data: { items: [{
      id: 'channel-1', snippet: { title: 'Saevond', defaultLanguage: 'en' },
      contentDetails: { relatedPlaylists: { uploads: 'uploads-1' } }
    }] } }) },
    playlistItems: { list: async (params) => {
      playlistCalls.push(params);
      const start = params.pageToken ? 50 : 0;
      return { data: {
        nextPageToken: start === 0 ? 'page-2' : undefined,
        pageInfo: { totalResults: ids.length },
        items: ids.slice(start, start + 50).map((videoId) => ({ contentDetails: { videoId } }))
      } };
    } },
    videos: { list: async (params) => ({ data: { items: params.id.map((id) => ({
      id, etag: '"etag-' + id + '"',
      snippet: { title: 'Title ' + id, description: '', channelId: 'channel-1' },
      status: { privacyStatus: 'public' }, localizations: {}
    })) } }) }
  });
  const page = await youtube.ownedVideosPage(50, 10);
  assert.equal(page.channelId, 'channel-1');
  assert.equal(page.total, 60);
  assert.equal(page.items.length, 10);
  assert.deepEqual(page.items.map((item) => item.id), ids.slice(50));
  assert.equal(playlistCalls.length, 2);
  assert.equal(playlistCalls[0].playlistId, 'uploads-1');
  assert.equal(playlistCalls[1].pageToken, 'page-2');
});

test('Japanese video localization preserves English metadata and other languages with an ETag check', async (t) => {
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
  const existing = {
    id: 'abcdefghijk', etag: '"video-etag"',
    snippet: { title: 'Apex Legends clutch #Shorts',
      description: 'English description https://example.com/vod\n00:01:23 - Final fight',
      tags: ['existing'], categoryId: '20', defaultLanguage: 'en',
      defaultAudioLanguage: 'en', channelId: 'channel-1' },
    localizations: {
      es: { title: 'Apex ES', description: 'Descripción en español' },
      ja: { title: 'Old Japanese', description: '古い説明です。' }
    }
  };
  let updateRequest;
  let failPrecondition = false;
  google.youtube = () => ({
    videos: {
      list: async () => ({ data: { items: [existing] } }),
      update: async (params, options) => {
        updateRequest = { params, options };
        if (failPrecondition) {
          const error = new Error('Precondition failed');
          error.code = 412;
          throw error;
        }
        return { data: {} };
      }
    },
    channels: { list: async () => ({ data: { items: [{
      id: 'channel-1', snippet: { defaultLanguage: 'en' },
      brandingSettings: { channel: { defaultLanguage: 'en' } }
    }] } }) }
  });
  await assert.rejects(youtube.updateJapaneseVideoLocalization({ id: 'abcdefghijk', etag: '"stale"' }, {
    title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ランク動画 https://example.com/vod\n00:01:23 - 最後の戦い'
  }), (error) => error.status === 409);
  assert.equal(updateRequest, undefined);

  failPrecondition = true;
  await assert.rejects(youtube.updateJapaneseVideoLocalization({ id: 'abcdefghijk', etag: '"video-etag"' }, {
    title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ランク動画 https://example.com/vod\n00:01:23 - 最後の戦い'
  }), (error) => error.status === 409 && /changed while saving/.test(error.message));
  failPrecondition = false;
  await youtube.updateJapaneseVideoLocalization({ id: 'abcdefghijk', etag: '"video-etag"' }, {
    title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ランク動画 https://example.com/vod\n00:01:23 - 最後の戦い'
  });
  assert.deepEqual(updateRequest.params.part, ['snippet', 'localizations']);
  assert.equal(updateRequest.params.requestBody.id, 'abcdefghijk');
  assert.deepEqual(updateRequest.params.requestBody.snippet, {
    title: existing.snippet.title,
    description: existing.snippet.description,
    tags: ['existing'], categoryId: '20', defaultLanguage: 'en',
    defaultAudioLanguage: 'en'
  });
  assert.deepEqual(updateRequest.params.requestBody.localizations.es, existing.localizations.es);
  assert.deepEqual(updateRequest.params.requestBody.localizations.ja, {
    title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ランク動画 https://example.com/vod\n00:01:23 - 最後の戦い'
  });
  assert.equal(updateRequest.params.requestBody.status, undefined);
  assert.equal(updateRequest.options.headers['If-Match'], '"video-etag"');
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

test('Japanese channel localization preserves other languages and uses the channel ETag', async (t) => {
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
  let failPrecondition = false;
  const existingLocalizations = {
    es: { title: 'Saevond ES', description: 'Perfil existente' },
    ja: { title: 'Old title', description: '古い紹介文です。' }
  };
  google.youtube = () => ({
    channels: {
      list: async (params) => ({ data: { items: [{
        id: 'channel-1', etag: '"channel-etag"',
        snippet: { title: 'Saevond', description: 'Existing English channel identity' },
        brandingSettings: { channel: {
          title: 'Saevond', description: 'Existing English channel identity', keywords: 'gaming',
          country: 'US', defaultLanguage: 'en'
        } },
        localizations: existingLocalizations,
        contentDetails: { relatedPlaylists: { uploads: 'uploads-1' } }
      }] } }),
      update: async (params, options) => {
        request = { params, options };
        if (failPrecondition) {
          const error = new Error('Precondition failed');
          error.code = 412;
          throw error;
        }
        return { data: {} };
      }
    }
  });

  const current = await youtube.channelSeo();
  assert.ok(current.localizations.es);
  await assert.rejects(youtube.updateJapaneseChannelLocalization({ id: current.id, etag: 'stale' }, {
    title: 'Saevond', description: '日本語のチャンネル紹介です。'
  }), /settings changed/);
  assert.equal(request, undefined);

  failPrecondition = true;
  await assert.rejects(youtube.updateJapaneseChannelLocalization(current, {
    title: 'Saevond', description: '実況なしのゲームプレイ動画を投稿しています。'
  }), (error) => error.status === 409 && /refresh before trying again/.test(error.message));
  failPrecondition = false;

  await youtube.updateJapaneseChannelLocalization(current, {
    title: 'Saevond', description: '実況なしのゲームプレイ動画を投稿しています。'
  });
  assert.deepEqual(request.params.part, ['localizations']);
  assert.equal(request.params.requestBody.id, 'channel-1');
  assert.deepEqual(request.params.requestBody.localizations.es, existingLocalizations.es);
  assert.deepEqual(request.params.requestBody.localizations.ja, {
    title: 'Saevond', description: '実況なしのゲームプレイ動画を投稿しています。'
  });
  assert.equal(Object.hasOwn(request.params.requestBody, 'brandingSettings'), false);
  assert.equal(request.options.headers['If-Match'], '"channel-etag"');
  assert.equal(current.description, 'Existing English channel identity');
});

test('Japanese channel localization sets the required English source language without replacing its description', async (t) => {
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
    channels: {
      list: async () => ({ data: { items: [{
        id: 'channel-1', etag: '"channel-etag"',
        snippet: { title: 'Saevond', description: 'Existing English channel identity' },
        brandingSettings: { channel: {
          title: 'Saevond', description: 'Existing English channel identity', keywords: 'gaming',
          country: 'US', unsubscribedTrailer: 'abcdefghijk'
        } },
        localizations: { es: { title: 'Saevond ES', description: 'Perfil existente' } }
      }] } }),
      update: async (params, options) => { request = { params, options }; return { data: {} }; }
    }
  });

  const current = await youtube.channelSeo();
  await youtube.updateJapaneseChannelLocalization(current, {
    title: 'Saevond', description: '日本語のチャンネル紹介です。'
  });
  assert.deepEqual(request.params.part, ['brandingSettings', 'localizations']);
  assert.deepEqual(request.params.requestBody.brandingSettings.channel, {
    title: 'Saevond', description: 'Existing English channel identity', keywords: 'gaming',
    country: 'US', unsubscribedTrailer: 'abcdefghijk', defaultLanguage: 'en'
  });
  assert.equal(request.params.requestBody.localizations.es.description, 'Perfil existente');
  assert.equal(request.options.headers['If-Match'], '"channel-etag"');
});

test('public broadcast ads update preserves existing metadata and schedule with the current version', async (t) => {
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
    snippet: { channelId: 'channel-1', title: 'Current stream', description: 'Description',
      categoryId: '20', scheduledStartTime: '2026-10-02T12:00:00Z' },
    status: { privacyStatus: 'public', lifeCycleStatus: 'live' },
    contentDetails: { monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 },
      enableDvr: true, recordFromStart: true },
    monetizationDetails: { adsMonetizationStatus: 'off', eligibleForAdsMonetization: true,
      cuepointSchedule: { enabled: true, ytOptimizedCuepointConfig: 'MEDIUM' } }
  };
  await assert.rejects(youtube.enablePublicBroadcastAds({ ...current,
    status: { privacyStatus: 'private', lifeCycleStatus: 'live' } }), /eligible/);
  assert.equal(request, undefined);
  await youtube.enablePublicBroadcastAds(current);
  assert.deepEqual(request.params.part, ['snippet', 'contentDetails', 'monetizationDetails']);
  assert.equal(Object.hasOwn(request.params.requestBody, 'status'), false);
  assert.deepEqual(request.params.requestBody.snippet, {
    title: 'Current stream', description: 'Description', categoryId: '20',
    scheduledStartTime: '2026-10-02T12:00:00Z'
  });
  assert.deepEqual(request.params.requestBody.contentDetails, current.contentDetails);
  assert.deepEqual(request.params.requestBody.monetizationDetails, {
    adsMonetizationStatus: 'on',
    cuepointSchedule: { enabled: true, ytOptimizedCuepointConfig: 'MEDIUM' }
  });
  assert.equal(request.options.headers['If-Match'], current.etag);
  await youtube.enablePublicBroadcastAds({ ...current, monetizationDetails: {
    adsMonetizationStatus: 'off', eligibleForAdsMonetization: true
  } });
  assert.deepEqual(request.params.requestBody.monetizationDetails.cuepointSchedule, { enabled: false });
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
  assert.equal(query.maxResults, 50);
  assert.equal(query.publishedAfter, '2026-09-25T12:00:00.000Z');
  assert.deepEqual(items.map((item) => item.id), ['public-2', 'public-1']);
  assert.deepEqual(items.map((item) => item.estimatedViewsPerDay), [333, 67]);
});

test('market search ranks recent examples by age-adjusted views per day', async (t) => {
  const oldYoutube = google.youtube;
  const oldTokens = store.getTokens;
  const oldBaseUrl = process.env.BASE_URL;
  t.after(() => { google.youtube = oldYoutube; store.getTokens = oldTokens;
    process.env.BASE_URL = oldBaseUrl; });
  process.env.BASE_URL = 'https://amaana.example.test';
  store.getTokens = async () => ({ access_token: 'unit-test', expiry_date: Date.now() + 3600000 });
  google.youtube = () => ({
    search: { list: async () => ({ data: { items: [
      { id: { videoId: 'older-high-total' } },
      { id: { videoId: 'newer-lower-total' } },
      { id: { videoId: 'future' } },
      { id: { videoId: 'invalid-date' } }
    ] } }) },
    videos: { list: async () => ({ data: { items: [
      { id: 'older-high-total', snippet: { title: 'Older high view count',
        publishedAt: '2026-10-01T12:00:00Z', channelId: 'other' },
        statistics: { viewCount: '1200' }, status: { privacyStatus: 'public' } },
      { id: 'newer-lower-total', snippet: { title: 'Newer rising video',
        publishedAt: '2026-10-06T12:00:00Z', channelId: 'other' },
        statistics: { viewCount: '250' }, status: { privacyStatus: 'public' } },
      { id: 'future', snippet: { title: 'Future video',
        publishedAt: '2026-10-09T00:00:00Z', channelId: 'other' },
        statistics: { viewCount: '999999' }, status: { privacyStatus: 'public' } },
      { id: 'invalid-date', snippet: { title: 'Invalid date',
        publishedAt: 'not-a-date', channelId: 'other' },
        statistics: { viewCount: '999999' }, status: { privacyStatus: 'public' } }
    ] } }) }
  });
  const items = await youtube.recentGameVideos('ARC Raiders', { now: Date.parse('2026-10-07T12:00:00Z') });
  assert.deepEqual(items.map((item) => item.id), ['newer-lower-total', 'older-high-total']);
  assert.deepEqual(items.map((item) => item.estimatedViewsPerDay), [250, 200]);
});


test('private uploads omit unsupported spoken-audio metadata', async (t) => {
  const oldYoutube = google.youtube;
  const oldTokens = store.getTokens;
  const oldBaseUrl = process.env.BASE_URL;
  const oldCreateReadStream = fs.createReadStream;
  t.after(() => {
    google.youtube = oldYoutube;
    store.getTokens = oldTokens;
    process.env.BASE_URL = oldBaseUrl;
    fs.createReadStream = oldCreateReadStream;
  });
  process.env.BASE_URL = 'https://amaana.example.test';
  store.getTokens = async () => ({ access_token: 'unit-test', expiry_date: Date.now() + 3600000 });
  fs.createReadStream = () => ({ mockedVideoStream: true });
  let request;
  google.youtube = () => ({ videos: { insert: async (params) => {
    request = params;
    return { data: { id: 'abcdefghijk' } };
  } } });

  await youtube.uploadPrivate({ filePath: '/not-read.mp4', title: 'Gameplay',
    description: 'English metadata', tags: ['gameplay'] });

  assert.deepEqual(request.requestBody.snippet, {
    title: 'Gameplay', description: 'English metadata', tags: ['gameplay', '@saevond'],
    categoryId: '20', defaultLanguage: 'en'
  });
  assert.equal(Object.hasOwn(request.requestBody.snippet, 'defaultAudioLanguage'), false);
});
