'use strict';

const TIME_ZONE = 'America/Los_Angeles';
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const quotaBlockCache = new WeakMap();
const quotaBlockCheckedAt = new WeakMap();
const EMPTY_CACHE_TTL_MS = 1000;

function dateParts(timestamp) {
  const value = Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(value.year), month: Number(value.month), day: Number(value.day),
    hour: Number(value.hour), minute: Number(value.minute), second: Number(value.second)
  };
}

function youtubeQuotaDate(timestamp = Date.now()) {
  const { year, month, day } = dateParts(timestamp);
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'),
    String(day).padStart(2, '0')].join('-');
}

function zoneOffset(timestamp) {
  const parts = dateParts(timestamp);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second);
  return zonedAsUtc - Math.floor(timestamp / 1000) * 1000;
}

function nextYoutubeQuotaReset(timestamp = Date.now()) {
  const { year, month, day } = dateParts(timestamp);
  const nextLocalMidnightAsUtc = Date.UTC(year, month - 1, day + 1);
  const firstEstimate = nextLocalMidnightAsUtc - zoneOffset(timestamp);
  // Recalculate at the estimated reset so a daylight-saving transition is handled.
  return nextLocalMidnightAsUtc - zoneOffset(firstEstimate);
}

function youtubeErrorText(error) {
  const apiError = error?.response?.data?.error || {};
  const apiDetails = typeof apiError === 'string' ? apiError : [
    apiError.status, apiError.message,
    ...(Array.isArray(apiError.errors) ? apiError.errors.map((item) => item?.reason) : [])
  ];
  return [...apiDetails, error?.response?.data?.error_description, error?.status,
    error?.code, error?.message].filter(Boolean).join(' ').toLowerCase();
}

function isYouTubeDailyQuotaError(error) {
  const text = youtubeErrorText(error);
  return /quotaexceeded|dailylimitexceeded|daily\s+quota|quota.{0,160}exceed(?:ed|s)?|exceed(?:ed|s)?.{0,160}quota/.test(text);
}

function isYouTubeQuotaError(error) {
  return isYouTubeDailyQuotaError(error) ||
    /ratelimitexceeded|userratelimitexceeded|resourceexhausted/.test(youtubeErrorText(error));
}

function youtubeQuotaRetryAt(error, timestamp = Date.now()) {
  return isYouTubeDailyQuotaError(error)
    ? nextYoutubeQuotaReset(timestamp)
    : isYouTubeQuotaError(error) ? timestamp + 5 * 60 * 1000 : null;
}

function normalizedQuotaBlock(value, timestamp = Date.now()) {
  const raw = value?.blockedUntil ?? value?.youtubeDataApiBlockedUntil;
  const blockedUntil = typeof raw === 'number' ? raw : Date.parse(raw || '');
  if (!Number.isFinite(blockedUntil) || blockedUntil <= timestamp) return null;
  return {
    blockedUntil,
    reason: String(value?.reason || value?.youtubeDataApiBlockReason ||
      'YouTube Data API quota or rate limit reached').slice(0, 180)
  };
}

function laterQuotaBlock(left, right) {
  if (!left) return right;
  if (!right) return left;
  return right.blockedUntil > left.blockedUntil ? right : left;
}

async function readStoredQuotaBlock(store) {
  if (typeof store?.getYoutubeDataApiQuotaBlock === 'function') {
    return store.getYoutubeDataApiQuotaBlock();
  }
  if (typeof store?.getSeoSyncState === 'function') return store.getSeoSyncState();
  return null;
}

async function getYouTubeDataApiQuotaBlock(store, timestamp = Date.now()) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) return null;
  const cached = normalizedQuotaBlock(quotaBlockCache.get(store), timestamp);
  if (cached) return cached;
  quotaBlockCache.delete(store);
  const checkedAt = quotaBlockCheckedAt.get(store);
  if (Number.isFinite(checkedAt) && timestamp >= checkedAt &&
      timestamp - checkedAt < EMPTY_CACHE_TTL_MS) return null;
  const persisted = normalizedQuotaBlock(await readStoredQuotaBlock(store), timestamp);
  quotaBlockCheckedAt.set(store, timestamp);
  if (persisted) quotaBlockCache.set(store, persisted);
  return persisted;
}

async function isYouTubeDataApiBlocked(store, timestamp = Date.now()) {
  return Boolean(await getYouTubeDataApiQuotaBlock(store, timestamp));
}

function quotaPauseError(block) {
  const error = new Error('YouTube Data API paused until ' + new Date(block.blockedUntil).toISOString());
  error.code = 'YOUTUBE_DATA_API_QUOTA_PAUSED';
  error.status = 429;
  error.youtubeDataApiQuotaBlock = block;
  return error;
}

async function recordYouTubeDataApiQuotaBlock(store, errorOrRetryAt, timestamp = Date.now()) {
  const retryAt = typeof errorOrRetryAt === 'number'
    ? errorOrRetryAt : youtubeQuotaRetryAt(errorOrRetryAt, timestamp);
  if (!Number.isFinite(retryAt) || retryAt <= timestamp) return null;
  const proposed = {
    blockedUntil: retryAt,
    reason: typeof errorOrRetryAt === 'number'
      ? 'YouTube Data API quota or rate limit reached'
      : isYouTubeDailyQuotaError(errorOrRetryAt)
        ? 'YouTube Data API daily quota exceeded'
        : 'YouTube Data API rate limit reached'
  };
  const cached = store && (typeof store === 'object' || typeof store === 'function')
    ? normalizedQuotaBlock(quotaBlockCache.get(store), timestamp) : null;
  let block = laterQuotaBlock(cached, proposed);
  if (store && (typeof store === 'object' || typeof store === 'function')) {
    // Publish the in-process pause before awaiting storage so sibling workers stop too.
    quotaBlockCache.set(store, block);
    quotaBlockCheckedAt.set(store, timestamp);
  }

  let persisted = false;
  let persistenceError = null;
  try {
    if (typeof store?.saveYoutubeDataApiQuotaBlock === 'function') {
      const saved = await store.saveYoutubeDataApiQuotaBlock({
        blockedUntil: new Date(block.blockedUntil).toISOString(), reason: block.reason
      });
      block = laterQuotaBlock(block, normalizedQuotaBlock(saved, timestamp));
      persisted = true;
    } else if (typeof store?.saveSeoSyncState === 'function') {
      const state = typeof store.getSeoSyncState === 'function'
        ? await store.getSeoSyncState() : {};
      block = laterQuotaBlock(block, normalizedQuotaBlock(state, timestamp));
      await store.saveSeoSyncState({ ...state,
        youtubeDataApiBlockedUntil: new Date(block.blockedUntil).toISOString(),
        youtubeDataApiBlockReason: block.reason
      });
      persisted = true;
    }
  } catch (error) {
    persistenceError = error;
  }
  if (store && (typeof store === 'object' || typeof store === 'function')) {
    quotaBlockCache.set(store, block);
    quotaBlockCheckedAt.set(store, timestamp);
  }
  return { ...block, persisted, ...(persistenceError ? { persistenceError } : {}) };
}

async function callYouTubeDataApi(store, operation, timestamp = Date.now()) {
  if (typeof operation !== 'function') throw new TypeError('A YouTube Data API operation is required');
  const activeBlock = await getYouTubeDataApiQuotaBlock(store, timestamp);
  if (activeBlock) throw quotaPauseError(activeBlock);
  try {
    return await operation();
  } catch (error) {
    if (isYouTubeQuotaError(error)) {
      const block = await recordYouTubeDataApiQuotaBlock(store, error, timestamp);
      if (block) {
        try { error.youtubeDataApiQuotaBlock = block; } catch {}
        if (block.persistenceError) {
          try { error.youtubeDataApiQuotaPersistenceError = block.persistenceError; } catch {}
        }
      }
    }
    throw error;
  }
}

module.exports = {
  youtubeQuotaDate, nextYoutubeQuotaReset,
  isYouTubeDailyQuotaError, isYouTubeQuotaError, youtubeQuotaRetryAt,
  getYouTubeDataApiQuotaBlock, isYouTubeDataApiBlocked,
  recordYouTubeDataApiQuotaBlock, callYouTubeDataApi
};
