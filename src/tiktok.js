const store = require('./store');

const API = 'https://open.tiktokapis.com';
const REQUIRED_SCOPES = ['user.info.basic', 'video.upload'];

function configured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

function redirectUri() {
  return new URL('/oauth/tiktok/callback', process.env.BASE_URL).toString();
}

function authorizationUrl(state) {
  if (!configured()) throw new Error('Set TikTok client key and secret in Render first');
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.search = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: REQUIRED_SCOPES.join(','),
    redirect_uri: redirectUri(),
    state
  }).toString();
  return url.toString();
}

async function request(endpoint, { token, body, form = false, method = 'POST' } = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=UTF-8'
    },
    ...(body ? { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok || result.error && (typeof result.error === 'string' || result.error.code !== 'ok')) {
    const code = typeof result.error === 'string' ? result.error : result.error?.code;
    throw new Error(`TikTok ${code || response.status}: ${result.error_description || result.error?.message || 'Request failed'}`);
  }
  return result;
}

function tokenRecord(tokens, previous = {}) {
  return {
    ...previous,
    ...tokens,
    refresh_token: tokens.refresh_token || previous.refresh_token,
    expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000
  };
}

async function exchangeCode(code) {
  if (!configured()) throw new Error('TikTok is not configured');
  const tokens = await request('/v2/oauth/token/', {
    form: true,
    body: { client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code, grant_type: 'authorization_code', redirect_uri: redirectUri() }
  });
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('TikTok did not return renewable access');
  await store.saveTikTokTokens(tokenRecord(tokens));
}

async function accessToken() {
  if (!configured()) throw new Error('TikTok is not configured');
  let tokens = await store.getTikTokTokens();
  if (!tokens?.refresh_token || !tokens?.scope?.split(',').includes('video.upload')) {
    throw new Error('Connect TikTok and approve video.upload in the owner dashboard');
  }
  if (tokens.expiresAt < Date.now() + 5 * 60 * 1000) {
    const refreshed = await request('/v2/oauth/token/', { form: true,
      body: { client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: tokens.refresh_token } });
    if (!refreshed.access_token) throw new Error('TikTok token refresh failed');
    tokens = tokenRecord(refreshed, tokens);
    await store.saveTikTokTokens(tokens);
  }
  return tokens.access_token;
}

async function connectionStatus() {
  if (!configured()) return { configured: false, connected: false };
  const tokens = await store.getTikTokTokens();
  if (!tokens?.refresh_token || !tokens.scope?.split(',').includes('video.upload')) {
    return { configured: true, connected: false };
  }
  try {
    const profile = await request('/v2/user/info/?fields=display_name', {
      token: await accessToken(), method: 'GET'
    });
    return { configured: true, connected: true, displayName: profile.data?.user?.display_name || 'TikTok creator' };
  } catch (error) {
    return { configured: true, connected: false, error: error.message };
  }
}

async function uploadToInbox(mediaUrl) {
  const result = await request('/v2/post/publish/inbox/video/init/', {
    token: await accessToken(),
    body: { source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl } }
  });
  if (!result.data?.publish_id) throw new Error('TikTok did not return an upload ID');
  return result.data.publish_id;
}

async function fetchStatus(publishId) {
  const result = await request('/v2/post/publish/status/fetch/', {
    token: await accessToken(), body: { publish_id: publishId }
  });
  return { status: result.data?.status || 'UNKNOWN', reason: result.data?.fail_reason || null };
}

module.exports = { authorizationUrl, exchangeCode, connectionStatus, uploadToInbox, fetchStatus };
