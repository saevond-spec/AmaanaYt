'use strict';

const { chooseAutoPlaylist } = require('./youtube-playlists');
const { isYouTubeAuthorizationError } = require('./channel-tags');

function setting(value, fallback, cap) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, cap) : fallback;
}

function youtubeQuotaDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return [value.year, value.month, value.day].join('-');
}

function playlistErrorState(error) {
  const apiError = error?.response?.data?.error || {};
  const reasons = (apiError.errors || []).map((item) => String(item?.reason || '')).join(' ');
  const status = Number(error?.response?.status || error?.status || apiError.code);
  const detail = `${reasons} ${apiError.status || ''} ${apiError.message || ''} ${error?.message || ''}`.toLowerCase();

  if (isYouTubeAuthorizationError(error) ||
      /playlistitemsnotaccessible|playlistforbidden|insufficientpermissions|insufficient.?scope/.test(detail)) {
    return 'authorization_required';
  }
  if (/quotaexceeded|ratelimitexceeded|userratelimitexceeded|backenderror|internalerror|serviceunavailable|resourceexhausted/.test(detail)) {
    return 'retry';
  }
  if (/playlistnotfound|videonotfound/.test(detail)) return 'retry';
  if (/playlistcontainsmaximumnumberofvideos|videoalreadyinanotherseriesplaylist/.test(detail)) {
    return 'manual_review';
  }
  if (status === 400 || status === 404 || status === 409) return 'manual_review';
  if (status === 403) return 'authorization_required';
  return 'retry';
}

function createPlaylistAutoAssigner({ store, youtube, env = process.env, logger = console, now = Date.now }) {
  if (!store || !youtube) throw new TypeError('Store and YouTube clients are required');
  const enabled = env.YOUTUBE_AUTO_PLAYLISTS !== 'false';
  const dailyLimit = setting(env.YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT, 30, 30);
  const batchSize = setting(env.YOUTUBE_AUTO_PLAYLIST_BATCH_SIZE, 50, 50);
  let playlistsCache = null;
  let playlistsCacheAt = 0;
  let authorizationBlocked = false;

  async function getOwnedPlaylists() {
    if (playlistsCache && now() - playlistsCacheAt < 5 * 60 * 1000) return playlistsCache;
    playlistsCache = await youtube.listOwnedPlaylists();
    playlistsCacheAt = now();
    return playlistsCache;
  }

  async function assign(video = {}) {
    if (!enabled) return { state: 'disabled' };
    const videoId = String(video.id || video.videoId || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { state: 'ineligible', reason: 'invalid_video_id' };
    const privacyStatus = video.privacyStatus || video.status?.privacyStatus || video.source?.privacyStatus;
    if (!['public', 'private', 'unlisted'].includes(privacyStatus)) {
      return { state: 'ineligible', reason: 'unknown_video_privacy' };
    }
    if (authorizationBlocked) return { state: 'authorization_required', reason: 'reconnect_youtube' };

    try {
      const playlists = await getOwnedPlaylists();
      const selected = chooseAutoPlaylist({ ...video, id: videoId, privacyStatus }, playlists);
      const playlist = selected.playlist;
      if (!playlist) {
        return { state: selected.state, reason: selected.reason, needsReview: true };
      }

      const quotaBucket = playlist.privacyStatus === 'public' ? 'public' : 'private';
      const slot = await store.reservePlaylistAutoSlot(quotaBucket, dailyLimit, youtubeQuotaDate(now()));
      if (!slot?.allowed) return { state: 'daily_limit', privacyStatus: quotaBucket, limit: dailyLimit };

      const result = await youtube.addVideoToPlaylist({ playlistId: playlist.id, videoId });
      return {
        state: result.alreadyAdded ? 'already_added' : 'added',
        playlistId: playlist.id,
        playlistTitle: playlist.title,
        privacyStatus: playlist.privacyStatus,
        score: selected.score
      };
    } catch (error) {
      const state = playlistErrorState(error);
      if (state === 'authorization_required') {
        authorizationBlocked = true;
        playlistsCache = null;
        playlistsCacheAt = 0;
      } else if (Number(error?.response?.status || error?.status || error?.response?.data?.error?.code) === 404) {
        playlistsCache = null;
        playlistsCacheAt = 0;
      }
      logger.warn?.('Automatic playlist assignment failed for ' + videoId + ': ' + error.message);
      return {
        state,
        reason: String(error.message || 'YouTube request failed').slice(0, 300),
        ...(state === 'retry' ? { at: new Date(now()).toISOString() } : {})
      };
    }
  }

  async function auditCatalogCoverage() {
    if (typeof youtube.ownedChannel !== 'function' || typeof youtube.uploadsPage !== 'function' ||
        typeof youtube.listPlaylistVideoIds !== 'function') {
      throw new Error('YouTube playlist coverage audit is unavailable');
    }
    const [channel, syncState] = await Promise.all([
      youtube.ownedChannel(),
      typeof store.getSeoSyncState === 'function' ? store.getSeoSyncState() : Promise.resolve({})
    ]);
    if (syncState.channelId && syncState.channelId !== channel.id) {
      throw new Error('YouTube channel changed; playlist coverage audit stopped to avoid mixing channels');
    }
    if (!channel.uploads) throw new Error('The connected YouTube account has no uploads playlist');

    const catalogIds = new Set();
    const seenTokens = new Set();
    let pageToken = null;
    let catalogPages = 0;
    do {
      const page = await youtube.uploadsPage(channel.uploads, pageToken);
      catalogPages += 1;
      for (const videoId of page.ids || []) {
        if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) catalogIds.add(videoId);
      }
      const nextPageToken = page.nextPageToken || null;
      if (nextPageToken && seenTokens.has(nextPageToken)) {
        throw new Error('YouTube uploads pagination repeated a page token');
      }
      if (nextPageToken) seenTokens.add(nextPageToken);
      pageToken = nextPageToken;
    } while (pageToken);

    const playlists = await getOwnedPlaylists();
    const playlistVideoIds = new Set();
    const publicPlaylistVideoIds = new Set();
    const playlistSummaries = [];
    const failedPlaylists = [];
    let membershipCount = 0;
    for (const playlist of playlists) {
      try {
        const ids = await youtube.listPlaylistVideoIds(playlist.id);
        const videoIds = Array.isArray(ids) ? ids : [];
        membershipCount += videoIds.length;
        for (const videoId of videoIds) {
          playlistVideoIds.add(videoId);
          if (playlist.privacyStatus === 'public') publicPlaylistVideoIds.add(videoId);
        }
        playlistSummaries.push({
          title: playlist.title,
          privacyStatus: playlist.privacyStatus,
          videoCount: videoIds.length,
          catalogVideoCount: videoIds.filter((videoId) => catalogIds.has(videoId)).length
        });
      } catch (error) {
        failedPlaylists.push({
          title: playlist.title,
          error: String(error.message || 'Playlist could not be read').slice(0, 200)
        });
      }
    }
    const missingVideoIds = [...catalogIds].filter((videoId) => !playlistVideoIds.has(videoId));
    const coveredCount = catalogIds.size - missingVideoIds.length;
    const publicCoverageCount = [...catalogIds].filter((videoId) => publicPlaylistVideoIds.has(videoId)).length;
    return {
      channelId: channel.id,
      channelTitle: channel.title || '',
      checkedAt: new Date(now()).toISOString(),
      catalogPages,
      catalogCount: catalogIds.size,
      playlistCount: playlists.length,
      membershipCount,
      coveredCount,
      publicCoverageCount,
      missingCount: missingVideoIds.length,
      missingVideoIds,
      playlists: playlistSummaries,
      failedPlaylists,
      complete: failedPlaylists.length === 0,
      catalogScanComplete: syncState.completed === true
    };
  }

  async function reconcilePlaylistCoverage() {
    const report = await auditCatalogCoverage();
    let requeuedCount = 0;
    if (report.complete && report.catalogScanComplete && report.missingVideoIds.length &&
        typeof store.requeueSeoPlaylistResults === 'function') {
      requeuedCount = await store.requeueSeoPlaylistResults(report.missingVideoIds);
    }
    return { ...report, requeuedCount };
  }

  async function assignCatalogBacklog() {
    if (!enabled || typeof store.listSeoNeedsPlaylist !== 'function' ||
        typeof store.markSeoPlaylistResult !== 'function') return { attempted: 0, assigned: 0 };
    if (authorizationBlocked) return { attempted: 0, assigned: 0, blocked: 'authorization_required' };

    // Separate the public and non-public queues so a long run of public videos cannot
    // monopolize every batch. Hidden videos are still routed only to private playlists.
    const publicLimit = Math.ceil(batchSize / 2);
    const nonPublicLimit = batchSize - publicLimit;
    const [publicCandidates, nonPublicCandidates] = await Promise.all([
      store.listSeoNeedsPlaylist(publicLimit, 'public'),
      nonPublicLimit
        ? store.listSeoNeedsPlaylist(nonPublicLimit, 'nonpublic')
        : Promise.resolve([])
    ]);
    const candidates = [];
    const pairCount = Math.max(publicCandidates?.length || 0, nonPublicCandidates?.length || 0);
    for (let index = 0; index < pairCount; index += 1) {
      if (publicCandidates?.[index]) candidates.push(publicCandidates[index]);
      if (nonPublicCandidates?.[index]) candidates.push(nonPublicCandidates[index]);
    }

    let attempted = 0;
    let assigned = 0;
    for (const candidate of candidates) {
      const result = await assign({
        ...(candidate.source || {}),
        id: candidate.videoId,
        context: candidate.context || {},
        package: candidate.package || null
      });
      if (result.state === 'daily_limit') continue;
      attempted += 1;
      if (['added', 'already_added'].includes(result.state)) assigned += 1;
      await store.markSeoPlaylistResult(candidate.videoId, result);
      if (result.state === 'authorization_required') break;
    }
    return { attempted, assigned };
  }

  return {
    enabled, dailyLimit, assign, assignCatalogBacklog, auditCatalogCoverage, reconcilePlaylistCoverage,
    assignPublicBacklog: assignCatalogBacklog,
    invalidatePlaylists: () => { playlistsCache = null; playlistsCacheAt = 0; },
    resumeAfterYouTubeReconnect: () => {
      authorizationBlocked = false;
      playlistsCache = null;
      playlistsCacheAt = 0;
    }
  };
}

module.exports = { createPlaylistAutoAssigner, youtubeQuotaDate };
