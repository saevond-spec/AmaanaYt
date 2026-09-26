const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BASE_URL = 'https://amaana.example.test';
process.env.TIKTOK_CLIENT_KEY = 'client-key';
process.env.TIKTOK_CLIENT_SECRET = 'private-secret';

const store = require('../src/store');
const tiktok = require('../src/tiktok');

test('OAuth URL and inbox delivery use the expected scopes and TikTok endpoint', async (t) => {
  const authUrl = new URL(tiktok.authorizationUrl('csrf-value'));
  assert.equal(authUrl.origin, 'https://www.tiktok.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://amaana.example.test/oauth/tiktok/callback');
  assert.equal(authUrl.searchParams.get('scope'), 'user.info.basic,video.upload');
  assert.equal(authUrl.searchParams.get('state'), 'csrf-value');

  let saved;
  const originalSave = store.saveTikTokTokens;
  const originalGet = store.getTikTokTokens;
  const originalFetch = global.fetch;
  t.after(() => {
    store.saveTikTokTokens = originalSave;
    store.getTikTokTokens = originalGet;
    global.fetch = originalFetch;
  });
  store.saveTikTokTokens = async (value) => { saved = value; };
  store.getTikTokTokens = async () => saved;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth/token/')) {
      return { ok: true, json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1',
        scope: 'user.info.basic,video.upload', expires_in: 3600 }) };
    }
    if (url.endsWith('/inbox/video/init/')) {
      return { ok: true, json: async () => ({ data: { publish_id: 'v_inbox_url~123' }, error: { code: 'ok' } }) };
    }
    return { ok: true, json: async () => ({ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } }) };
  };

  await tiktok.exchangeCode('one-time-code');
  assert.ok(saved.expiresAt > Date.now());
  const publishId = await tiktok.uploadToInbox('https://amaana.example.test/tiktok-media/signed.mp4');
  assert.equal(publishId, 'v_inbox_url~123');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    source_info: { source: 'PULL_FROM_URL', video_url: 'https://amaana.example.test/tiktok-media/signed.mp4' }
  });
  assert.equal(requests[1].options.headers.Authorization, 'Bearer access-1');
  assert.deepEqual(await tiktok.fetchStatus(publishId), { status: 'SEND_TO_USER_INBOX', reason: null });
});

test('expired token refreshes and revoked upload scope blocks delivery', async (t) => {
  const originalGet = store.getTikTokTokens;
  const originalSave = store.saveTikTokTokens;
  const originalFetch = global.fetch;
  t.after(() => {
    store.getTikTokTokens = originalGet;
    store.saveTikTokTokens = originalSave;
    global.fetch = originalFetch;
  });
  let saved = { access_token: 'expired', refresh_token: 'refresh-old', scope: 'video.upload', expiresAt: 1 };
  store.getTikTokTokens = async () => saved;
  store.saveTikTokTokens = async (tokens) => { saved = tokens; };
  let refreshes = 0;
  global.fetch = async (url) => {
    if (url.endsWith('/oauth/token/')) {
      refreshes++;
      return { ok: true, json: async () => ({ access_token: 'refreshed', refresh_token: 'refresh-new',
        expires_in: 3600, scope: 'video.upload' }) };
    }
    return { ok: true, json: async () => ({ data: { publish_id: 'v_inbox_url~456' }, error: { code: 'ok' } }) };
  };
  assert.equal(await tiktok.uploadToInbox('https://amaana.example.test/tiktok-media/signed.mp4'), 'v_inbox_url~456');
  assert.equal(refreshes, 1);
  assert.equal(saved.refresh_token, 'refresh-new');
  saved.scope = 'user.info.basic';
  await assert.rejects(tiktok.uploadToInbox('https://amaana.example.test/tiktok-media/signed.mp4'), /video.upload/);
});

test('TikTok rejects an unverified media URL before a delivery is reported', async (t) => {
  const originalGet = store.getTikTokTokens;
  const originalFetch = global.fetch;
  t.after(() => { store.getTikTokTokens = originalGet; global.fetch = originalFetch; });
  store.getTikTokTokens = async () => ({ access_token: 'valid', refresh_token: 'refresh',
    scope: 'video.upload', expiresAt: Date.now() + 3600000 });
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({
    error: { code: 'url_ownership_unverified', message: 'Verify the media URL' }
  }) });
  await assert.rejects(tiktok.uploadToInbox('https://amaana.example.test/tiktok-media/signed.mp4'),
    /url_ownership_unverified/);
});
