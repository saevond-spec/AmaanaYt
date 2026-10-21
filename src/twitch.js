const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const store = require('./store');
const { requireArchivedTwitchVod } = require('./highlight-validation');

const OAUTH_BASE = 'https://id.twitch.tv/oauth2';
const HELIX_BASE = 'https://api.twitch.tv/helix';
// Observed in Twitch's authenticated Get Clips Download response. Keep this host exact.
const TRUSTED_CLIP_DOWNLOAD_HOSTS = new Set(['d1ndex63qxojbr.cloudfront.net']);
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

function retryAfterDetails(headers, now = Date.now()) {
  const delays = [];
  const retryHeader = headers?.get?.('retry-after');
  if (retryHeader !== null && retryHeader !== undefined && String(retryHeader).trim() !== '') {
    const seconds = Number(retryHeader);
    const parsed = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000 : Date.parse(retryHeader) - now;
    if (Number.isFinite(parsed) && parsed >= 0) delays.push(Math.ceil(parsed));
  }
  const resetHeader = headers?.get?.('ratelimit-reset');
  if (resetHeader !== null && resetHeader !== undefined && String(resetHeader).trim() !== '') {
    const resetEpochSeconds = Number(resetHeader);
    if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds >= 0) {
      delays.push(Math.max(0, Math.ceil(resetEpochSeconds * 1000 - now)));
    }
  }
  return {
    retryAfterPresent: delays.length > 0,
    retryAfterMs: delays.length ? Math.max(...delays) : 0
  };
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
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Twitch API failed (${response.status})`);
    error.status = response.status;
    const retry = retryAfterDetails(response.headers);
    if (retry.retryAfterPresent) {
      error.retryAfterPresent = true;
      error.retryAfterMs = retry.retryAfterMs;
    } else if (response.status === 429) {
      // A missing rate-limit header must not trigger a tight polling loop.
      error.retryAfterMs = 60 * 1000;
    }
    throw error;
  }
  return payload;
}

async function currentUser() {
  const payload = await helix('/users');
  const user = payload.data?.[0];
  if (!user?.id) throw new Error('Twitch did not return the connected user');
  return user;
}

async function getVod(vodId) {
  const [payload, user] = await Promise.all([
    helix('/videos', { query: { id: String(vodId) } }), currentUser()
  ]);
  const vod = payload.data?.find((item) => String(item.id) === String(vodId));
  return requireArchivedTwitchVod(vod, vodId, user.id);
}

async function listRecentArchivedVods({ first = 100, maxPages = 10 } = {}) {
  const user = await currentUser();
  const requestedFirst = Math.floor(Number(first));
  const pageSize = Number.isFinite(requestedFirst) && requestedFirst > 0
    ? Math.min(100, Math.max(1, requestedFirst)) : 100;
  const requestedPages = Math.floor(Number(maxPages));
  const pageLimit = Number.isFinite(requestedPages) && requestedPages > 0
    ? Math.min(10, Math.max(1, requestedPages)) : 10;
  const [firstPage, streamsPayload] = await Promise.all([
    helix('/videos', { query: { user_id: user.id, type: 'archive', first: pageSize } }),
    helix('/streams', { query: { user_id: user.id, first: 100 } })
  ]);
  const videos = [...(firstPage.data || [])];
  const seenCursors = new Set();
  let cursor = firstPage.pagination && firstPage.pagination.cursor;
  for (let page = 1; page < pageLimit && cursor && !seenCursors.has(cursor); page += 1) {
    seenCursors.add(cursor);
    const nextPage = await helix('/videos', {
      query: { user_id: user.id, type: 'archive', first: pageSize, after: cursor }
    });
    videos.push(...(nextPage.data || []));
    cursor = nextPage.pagination && nextPage.pagination.cursor;
  }
  const activeStreamIds = new Set((streamsPayload.data || [])
    .map((stream) => String(stream.id || '')).filter(Boolean));
  const uniqueVideos = new Map();
  for (const vod of videos) {
    if (vod?.id && !uniqueVideos.has(String(vod.id))) uniqueVideos.set(String(vod.id), vod);
  }
  return [...uniqueVideos.values()]
    .filter((vod) => vod && vod.type === 'archive' && String(vod.user_id || '') === String(user.id))
    .filter((vod) => !activeStreamIds.has(String(vod.stream_id || '')) &&
      !activeStreamIds.has(String(vod.id || '')))
    .map((vod) => {
      try { return requireArchivedTwitchVod(vod, vod.id, user.id); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function getLiveBroadcast() {
  const user = await currentUser();
  const [streamsPayload, videosPayload] = await Promise.all([
    helix('/streams', { query: { user_id: user.id, first: 1 } }),
    helix('/videos', { query: { user_id: user.id, type: 'archive', first: 20 } })
  ]);
  const stream = (streamsPayload.data || []).find((item) =>
    item && String(item.user_id || '') === String(user.id));
  if (!stream) return null;
  const vod = (videosPayload.data || []).find((item) =>
    item && item.type === 'archive' &&
    String(item.user_id || '') === String(user.id) &&
    String(item.stream_id || '') === String(stream.id || ''));
  return { user, stream, vod: vod || null };
}

async function listRecentLiveClips({ startedAt, endedAt = new Date().toISOString(), maxPages = 10 } = {}) {
  const user = await currentUser();
  const now = Date.now();
  const parsedStart = Date.parse(startedAt || '');
  const parsedEnd = Date.parse(endedAt || '');
  const start = Math.max(Number.isFinite(parsedStart) ? parsedStart : now - 60 * 60 * 1000,
    now - 7 * 24 * 60 * 60 * 1000);
  const end = Math.min(Number.isFinite(parsedEnd) ? parsedEnd : now, now);
  if (start >= end) return [];
  const pageLimitValue = Math.floor(Number(maxPages));
  const pageLimit = Number.isFinite(pageLimitValue) && pageLimitValue > 0
    ? Math.min(10, pageLimitValue) : 10;
  const clips = [];
  const seenCursors = new Set();
  let after;
  for (let page = 0; page < pageLimit; page += 1) {
    const payload = await helix('/clips', {
      query: {
        broadcaster_id: user.id,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(end).toISOString(),
        first: 100,
        after
      }
    });
    clips.push(...(payload.data || []).filter((clip) =>
      String(clip.broadcaster_id || '') === String(user.id)));
    const cursor = payload.pagination && payload.pagination.cursor;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    after = cursor;
  }
  const unique = new Map();
  for (const clip of clips) if (clip && clip.id) unique.set(String(clip.id), clip);
  return [...unique.values()];
}

async function listClipsForVod(vod, { maxPages = 10 } = {}) {
  const user = await currentUser();
  const archive = requireArchivedTwitchVod(vod, vod && vod.id, user.id);
  const now = Date.now();
  const createdAt = Date.parse(archive.created_at || '');
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const durationMatch = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(String(archive.duration || ''));
  const durationSeconds = durationMatch
    ? Number(durationMatch[1] || 0) * 3600 + Number(durationMatch[2] || 0) * 60 + Number(durationMatch[3] || 0)
    : 0;
  const windows = [];
  if (Number.isFinite(createdAt)) {
    const historicalStart = createdAt - 24 * 60 * 60 * 1000;
    const historicalEnd = Math.min(now,
      createdAt + (durationSeconds > 0 ? durationSeconds : 24 * 60 * 60) * 1000 + 24 * 60 * 60 * 1000);
    if (historicalStart < historicalEnd) windows.push({ start: historicalStart, end: historicalEnd });
    const recentStart = weekAgo;
    if (recentStart < now) windows.push({ start: recentStart, end: now });
  } else if (weekAgo < now) {
    windows.push({ start: weekAgo, end: now });
  }
  const pageLimitValue = Math.floor(Number(maxPages));
  const pageLimit = Number.isFinite(pageLimitValue) && pageLimitValue > 0
    ? Math.min(10, pageLimitValue) : 10;
  const clips = [];
  let pagesRemaining = pageLimit;
  for (let windowIndex = 0; windowIndex < windows.length && pagesRemaining > 0; windowIndex += 1) {
    const window = windows[windowIndex];
    const windowsAfterThis = windows.length - windowIndex - 1;
    const fairShare = Math.max(1, Math.floor(pageLimit / windows.length));
    const windowBudget = windowsAfterThis === 0 ? pagesRemaining
      : Math.max(1, Math.min(fairShare, pagesRemaining - windowsAfterThis));
    const seenCursors = new Set();
    let after;
    for (let windowPages = 0; windowPages < windowBudget && pagesRemaining > 0; windowPages += 1) {
      const payload = await helix('/clips', {
        query: {
          broadcaster_id: user.id,
          started_at: new Date(window.start).toISOString(),
          ended_at: new Date(window.end).toISOString(),
          first: 100,
          after
        }
      });
      pagesRemaining -= 1;
      clips.push(...(payload.data || []).filter((clip) => String(clip.video_id || '') === String(archive.id)));
      const cursor = payload.pagination && payload.pagination.cursor;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      after = cursor;
    }
  }
  return [...new Map(clips.filter((clip) => clip && clip.id)
    .map((clip) => [String(clip.id), clip])).values()];
}

async function getClip(clipId) {
  const payload = await helix('/clips', { query: { id: String(clipId) } });
  const clip = payload.data?.find((item) => String(item.id) === String(clipId));
  if (!clip) {
    const error = new Error('Twitch clip timestamp metadata is not available yet');
    error.status = 425;
    throw error;
  }
  return clip;
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

async function waitForClipDownload({ clipId, broadcasterId, editorId, maxAttempts = 31,
  pollIntervalMs = 2000, maxInlineRetryAfterMs = 30000, helixRequest = helix,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let lastError;
  let nextPollDelay = 0;
  const attemptsValue = Math.floor(Number(maxAttempts));
  const attempts = Number.isFinite(attemptsValue) ? Math.max(1, Math.min(40, attemptsValue)) : 31;
  const intervalValue = Math.floor(Number(pollIntervalMs));
  const interval = Number.isFinite(intervalValue) ? Math.max(250, Math.min(5000, intervalValue)) : 2000;
  const inlineValue = Number(maxInlineRetryAfterMs);
  const maxInline = Number.isFinite(inlineValue) ? Math.max(0, inlineValue) : 30000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(Math.max(interval, nextPollDelay));
    try {
      const payload = await helixRequest('/clips/downloads', {
        query: { broadcaster_id: broadcasterId, editor_id: editorId, clip_id: clipId }
      });
      const item = payload.data?.[0];
      if (item?.portrait_download_url || item?.landscape_download_url) return item;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.statusCode || error?.response?.status);
      const transient = [408, 425, 429].includes(status) || status >= 500 && status <= 599 ||
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
          'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(
          String(error?.code || error?.cause?.code || '').toUpperCase());
      if (!transient) throw error;
      nextPollDelay = Number(error.retryAfterMs) > 0 ? Number(error.retryAfterMs) : 0;
      if (nextPollDelay > maxInline) throw error;
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
    url.hostname.endsWith('.ttvnw.net') ||
    TRUSTED_CLIP_DOWNLOAD_HOSTS.has(url.hostname)
  );
  if (!allowed) {
    const error = new Error('Twitch returned an unexpected clip download host: ' + url.hostname);
    error.status = 502;
    throw error;
  }
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
  retryAfterDetails,
  connectionStatus,
  authorizationUrl,
  exchangeCode,
  createClipFromVod,
  getVod,
  listRecentArchivedVods,
  getLiveBroadcast,
  listRecentLiveClips,
  listClipsForVod,
  getClip,
  waitForClipDownload,
  downloadClip
};

