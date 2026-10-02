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
