const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const store = require('./store');

const OAUTH_BASE = 'https://id.twitch.tv/oauth2';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const SCOPES = ['channel:manage:clips'];
let lastValidatedAt = 0;

function isConfigured() {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

function requireConfigured() {
  if (!isConfigured()) throw new Error('Twitch OAuth is not configured yet');
}

function redirectUri() {
  return new URL('/oauth/twitch/callback', process.env.BASE_URL).toString();
}

function authorizationUrl(state) {
  requireConfigured();
  const url = new URL(`${OAUTH_BASE}/authorize`);
  url.search = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    force_verify: 'true'
  }).toString();
  return url.toString();
}

async function tokenRequest(parameters) {
  requireConfigured();
  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    ...parameters
  });
  const response = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Twitch OAuth failed (${response.status})`);
  return payload;
}

function withExpiry(tokens, current = {}) {
  return {
    ...current,
    ...tokens,
    refresh_token: tokens.refresh_token || current.refresh_token,
    expires_at: Date.now() + Math.max(0, Number(tokens.expires_in || 0) - 60) * 1000
  };
}

async function exchangeCode(code) {
  const tokens = withExpiry(await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri()
  }));
  await store.saveTwitchTokens(tokens);
  return tokens;
}

async function refreshTokens(current) {
  if (!current.refresh_token) throw new Error('Twitch authorization expired; reconnect Twitch');
  const refreshed = withExpiry(await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token
  }), current);
  await store.saveTwitchTokens(refreshed);
  lastValidatedAt = 0;
  return refreshed;
}

async function validateToken(token) {
  const response = await fetch(`${OAUTH_BASE}/validate`, {
    headers: { authorization: `OAuth ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error('Twitch authorization is no longer valid');
    error.status = response.status;
    throw error;
  }
  const validation = await response.json();
  if (validation.client_id !== process.env.TWITCH_CLIENT_ID) throw new Error('Twitch token belongs to a different application');
  lastValidatedAt = Date.now();
  return validation;
}

async function accessToken() {
  let current = await store.getTwitchTokens();
  if (!current?.access_token) throw new Error('Twitch is not connected');
  if (current.expires_at && current.expires_at <= Date.now()) current = await refreshTokens(current);
  if (Date.now() - lastValidatedAt > 60 * 60 * 1000) {
    try {
      const validation = await validateToken(current.access_token);
      const updated = { ...current, expires_at: Date.now() + Number(validation.expires_in || 0) * 1000 };
      await store.saveTwitchTokens(updated);
      current = updated;
    } catch (error) {
      if (error.status !== 401) throw error;
      current = await refreshTokens(current);
      await validateToken(current.access_token);
    }
  }
  return current.access_token;
}

async function helix(pathname, { method = 'GET', query } = {}) {
  const url = new URL(`${HELIX_BASE}${pathname}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      'client-id': process.env.TWITCH_CLIENT_ID
    },
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Twitch API failed (${response.status})`);
  return payload;
}

async function currentUser() {
  const payload = await helix('/users');
  const user = payload.data?.[0];
  if (!user?.id) throw new Error('Twitch did not return the connected user');
  return user;
}

async function isConnected() {
  if (!isConfigured()) return false;
  const tokens = await store.getTwitchTokens();
  return Boolean(tokens?.access_token && (tokens?.refresh_token || tokens?.expires_at > Date.now()));
}

async function connectionStatus() {
  const configured = isConfigured();
  const connected = configured && await isConnected();
  if (!connected) return { configured, connected: false };
  try {
    const user = await currentUser();
    return { configured, connected: true, login: user.login, displayName: user.display_name };
  } catch (error) {
    return { configured, connected: false, error: error.message };
  }
}

async function createClipFromVod({ vodId, vodOffset, duration, title }) {
  const user = await currentUser();
  const payload = await helix('/videos/clips', {
    method: 'POST',
    query: {
      editor_id: user.id,
      broadcaster_id: user.id,
      vod_id: vodId,
      vod_offset: Math.round(vodOffset),
      duration: Number(duration.toFixed(1)),
      title
    }
  });
  const clip = payload.data?.[0];
  if (!clip?.id) throw new Error('Twitch accepted the request but did not return a clip ID');
  return { ...clip, broadcasterId: user.id, editorId: user.id };
}

async function waitForClipDownload({ clipId, broadcasterId, editorId }) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const payload = await helix('/clips/downloads', {
        query: { broadcaster_id: broadcasterId, editor_id: editorId, clip_id: clipId }
      });
      const item = payload.data?.[0];
      if (item?.portrait_download_url || item?.landscape_download_url) return item;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Twitch clip media was not ready in time');
}

function validateDownloadUrl(value) {
  const url = new URL(value);
  const allowed = url.protocol === 'https:' && (
    url.hostname === 'twitchcdn.net' ||
    url.hostname.endsWith('.twitchcdn.net') ||
    url.hostname === 'ttvnw.net' ||
    url.hostname.endsWith('.ttvnw.net')
  );
  if (!allowed) throw new Error('Twitch returned an unexpected clip download host');
  return url;
}

async function downloadClip(urlValue, destination) {
  let url = validateDownloadUrl(urlValue);
  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('Twitch clip download redirect was missing a destination');
    url = validateDownloadUrl(new URL(location, url).toString());
  }
  if (!response.ok || !response.body) throw new Error(`Twitch clip download failed (${response.status})`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 500 * 1024 * 1024) throw new Error('Twitch clip is unexpectedly large');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
}

module.exports = {
  isConfigured,
  isConnected,
  connectionStatus,
  authorizationUrl,
  exchangeCode,
  createClipFromVod,
  waitForClipDownload,
  downloadClip
};
