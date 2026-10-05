'use strict';

const { youtubeQuotaDate } = require('./playlist-auto');
const { ensureCreatorTag, youtubeTagCharacters, isYouTubeAuthorizationError } = require('./channel-tags');

function boundedSetting(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function retryable(error) {
  const status = Number(error?.status || error?.response?.status || error?.code);
  return isYouTubeAuthorizationError(error) || [408, 409, 412, 425, 429, 500, 502, 503, 504].includes(status) ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(error?.code);
}

function createChannelTagWorker({ store, youtube, env = process.env, logger = console, now = Date.now } = {}) {
  if (!store || !youtube) throw new TypeError('Store and YouTube clients are required');
  const enabled = env.YOUTUBE_HANDLE_TAG_SYNC !== 'false' &&
    typeof youtube.updateVideoTags === 'function';
  const dailyLimit = boundedSetting(env.YOUTUBE_HANDLE_TAG_DAILY_LIMIT, 20, 100);
  const perRunLimit = Math.min(dailyLimit, boundedSetting(env.YOUTUBE_HANDLE_TAG_RUN_LIMIT, 5, 20));
  const authCooldownMs = 30 * 60 * 1000;
  const errorCooldownMs = 5 * 60 * 1000;
  let running = false;

  function freshState(channelId) {
    return {
      channelId, cursor: null, pendingIds: [], nextPageToken: null, complete: false,
      quotaDate: null, writesToday: 0, scanned: 0, tagged: 0, skipped: 0,
      failures: [], blockedUntil: null, lastError: null, checkedAt: null
    };
  }

  async function run(channel, syncState = {}) {
    if (!enabled || running) return { state: syncState, disabled: !enabled, busy: running };
    running = true;
    const rootState = syncState || {};
    let progress = rootState.creatorTagSync;
    let writesThisRun = 0;
    let scannedThisRun = 0;
    let taggedThisRun = 0;
    let blocked = false;
    let authorizationRequired = false;

    const persist = async () => {
      if (!progress) progress = freshState(channel?.id || 'unknown');
      progress.checkedAt = new Date(now()).toISOString();
      rootState.creatorTagSync = progress;
      await store.saveSeoSyncState(rootState);
    };
    const fail = async (videoId, error) => {
      if (!progress) progress = freshState(channel?.id || 'unknown');
      const detail = String(error?.message || 'YouTube tag update failed').slice(0, 240);
      progress.lastError = { at: new Date(now()).toISOString(), videoId: videoId || null, message: detail };
      progress.failures = [...(progress.failures || []),
        { at: progress.lastError.at, videoId: videoId || null, message: detail }].slice(-100);
      if (isYouTubeAuthorizationError(error)) {
        progress.blockedUntil = new Date(now() + authCooldownMs).toISOString();
        authorizationRequired = true;
        blocked = true;
        logger.warn?.('Creator tag sync paused: YouTube authorization must be reconnected (' + detail + ')');
      } else if (retryable(error) || !videoId) {
        progress.blockedUntil = new Date(now() + errorCooldownMs).toISOString();
        blocked = true;
        logger.warn?.('Creator tag sync paused for retry: ' + detail);
      } else {
        logger.warn?.('Creator tag sync skipped ' + (videoId || 'page') + ': ' + detail);
      }
      await persist();
    };

    try {
      const owner = channel || await youtube.ownedChannel();
      if (!owner?.id || !owner?.uploads) throw new Error('YouTube channel uploads playlist is unavailable');
      if (!progress || progress.channelId !== owner.id) progress = freshState(owner.id);
      await youtube.assertTargetChannel(owner.id);

      const today = youtubeQuotaDate(now());
      if (progress.quotaDate !== today) {
        progress.quotaDate = today;
        progress.writesToday = 0;
      }
      if (Date.parse(progress.blockedUntil || '') > now()) {
        rootState.creatorTagSync = progress;
        return { state: rootState, blocked: true,
          authorizationRequired: Boolean(progress.lastError && isYouTubeAuthorizationError(progress.lastError)) };
      }
      if (progress.complete && progress.pendingIds.length === 0) {
        await syncActiveBroadcasts(owner, progress, persist, fail, () => writesThisRun,
          (count) => { writesThisRun = count; }, perRunLimit, dailyLimit,
          () => { taggedThisRun += 1; });
        await persist();
        return { state: rootState, complete: true, blocked, authorizationRequired,
          writes: writesThisRun, tagged: taggedThisRun };
      }

      await syncActiveBroadcasts(owner, progress, persist, fail, () => writesThisRun,
        (count) => { writesThisRun = count; }, perRunLimit, dailyLimit,
        () => { taggedThisRun += 1; });
      if (blocked || writesThisRun >= perRunLimit || progress.writesToday >= dailyLimit) {
        await persist();
        return { state: rootState, blocked, authorizationRequired, writes: writesThisRun, tagged: taggedThisRun };
      }

      if (!progress.pendingIds?.length) {
        const page = await youtube.uploadsPage(owner.uploads, progress.cursor || undefined);
        progress.pendingIds = (page.ids || []).slice();
        progress.nextPageToken = page.nextPageToken || null;
        if (!progress.pendingIds.length) {
          progress.cursor = progress.nextPageToken;
          progress.nextPageToken = null;
          progress.complete = !progress.cursor;
          await persist();
          return { state: rootState, complete: progress.complete, writes: writesThisRun, tagged: taggedThisRun };
        }
        await persist();
      }

      const ids = progress.pendingIds.slice(0, 50);
      const videos = await youtube.videoMetadata(ids);
      const byId = new Map((videos || []).map((item) => [item.id, item]));
      for (const id of ids) {
        if (writesThisRun >= perRunLimit || progress.writesToday >= dailyLimit) break;
        const item = byId.get(id);
        if (!item?.snippet) {
          progress.pendingIds = progress.pendingIds.filter((pendingId) => pendingId !== id);
          progress.scanned += 1;
          progress.skipped += 1;
          scannedThisRun += 1;
          await persist();
          continue;
        }
        if (item.snippet.channelId !== owner.id ||
            !['public', 'private', 'unlisted'].includes(item.status?.privacyStatus)) {
          progress.pendingIds = progress.pendingIds.filter((pendingId) => pendingId !== id);
          progress.scanned += 1;
          progress.skipped += 1;
          scannedThisRun += 1;
          await persist();
          continue;
        }

        const currentTags = Array.isArray(item.snippet.tags) ? item.snippet.tags : [];
        let targetTags;
        try {
          targetTags = ensureCreatorTag(currentTags, { trimOverflow: true });
        } catch (error) {
          progress.pendingIds = progress.pendingIds.filter((pendingId) => pendingId !== id);
          progress.scanned += 1;
          progress.skipped += 1;
          scannedThisRun += 1;
          await fail(id, error);
          if (blocked) break;
          await persist();
          continue;
        }
        progress.pendingIds = progress.pendingIds.filter((pendingId) => pendingId !== id);
        progress.scanned += 1;
        scannedThisRun += 1;
        if (JSON.stringify(targetTags) === JSON.stringify(currentTags)) {
          await persist();
          continue;
        }
        if (youtubeTagCharacters(targetTags) > 500) {
          progress.skipped += 1;
          await fail(id, new Error('Tag update exceeds YouTube’s 500-character tag limit'));
          if (blocked) break;
          continue;
        }

        progress.pendingIds.unshift(id);
        progress.writesToday += 1;
        writesThisRun += 1;
        await persist();
        try {
          await youtube.updateVideoTags(item, owner.id);
          progress.pendingIds = progress.pendingIds.filter((pendingId) => pendingId !== id);
          progress.tagged += 1;
          taggedThisRun += 1;
          progress.lastError = null;
          await persist();
        } catch (error) {
          await fail(id, error);
          break;
        }
      }

      if (!progress.pendingIds.length) {
        progress.cursor = progress.nextPageToken;
        progress.nextPageToken = null;
        progress.complete = !progress.cursor;
      }
      await persist();
      if (scannedThisRun || taggedThisRun) {
        logger.info?.('Creator tag sync: scanned=' + scannedThisRun + '; tagged=' + taggedThisRun +
          '; dailyWrites=' + progress.writesToday + '/' + dailyLimit + '; complete=' + progress.complete);
      }
      return { state: rootState, complete: progress.complete, blocked, authorizationRequired,
        writes: writesThisRun, tagged: taggedThisRun };
    } catch (error) {
      await fail(null, error);
      return { state: rootState, blocked, authorizationRequired,
        writes: writesThisRun, tagged: taggedThisRun };
    } finally {
      running = false;
    }
  }

  async function syncActiveBroadcasts(owner, progress, persist, fail, getWrites, setWrites,
    runLimit, dayLimit, onTagged) {
    if (getWrites() >= runLimit || progress.writesToday >= dayLimit ||
        typeof youtube.listOwnedBroadcasts !== 'function') return;
    let broadcasts;
    try {
      broadcasts = await youtube.listOwnedBroadcasts();
    } catch (error) {
      await fail(null, error);
      return;
    }
    const activeIds = [...new Set((broadcasts || [])
      .filter((broadcast) => broadcast.snippet?.channelId === owner.id &&
        ['created', 'ready', 'testing', 'live'].includes(broadcast.status?.lifeCycleStatus) &&
        ['public', 'private', 'unlisted'].includes(broadcast.status?.privacyStatus))
      .map((broadcast) => broadcast.id)
      .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(String(id || ''))))];
    if (!activeIds.length) return;
    let videos;
    try {
      videos = await youtube.videoMetadata(activeIds.slice(0, 50));
    } catch (error) {
      await fail(null, error);
      return;
    }
    for (const video of videos || []) {
      if (getWrites() >= runLimit || progress.writesToday >= dayLimit) break;
      if (video.snippet?.channelId !== owner.id ||
          !['public', 'private', 'unlisted'].includes(video.status?.privacyStatus)) continue;
      const currentTags = Array.isArray(video.snippet.tags) ? video.snippet.tags : [];
      const targetTags = ensureCreatorTag(currentTags, { trimOverflow: true });
      if (JSON.stringify(targetTags) === JSON.stringify(currentTags)) continue;
      progress.writesToday += 1;
      setWrites(getWrites() + 1);
      await persist();
      try {
        await youtube.updateVideoTags(video, owner.id);
        progress.tagged += 1;
        onTagged();
        progress.lastError = null;
        await persist();
      } catch (error) {
        await fail(video.id, error);
        return;
      }
    }
  }

  return { enabled, dailyLimit, perRunLimit, run };
}

module.exports = { createChannelTagWorker };
