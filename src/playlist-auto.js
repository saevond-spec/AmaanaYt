'use strict';

const { chooseAutoPlaylist } = require('./youtube-playlists');

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

function createPlaylistAutoAssigner({ store, youtube, env = process.env, logger = console, now = Date.now }) {
  if (!store || !youtube) throw new TypeError('Store and YouTube clients are required');
  const enabled = env.YOUTUBE_AUTO_PLAYLISTS !== 'false';
  const dailyLimit = setting(env.YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT, 20, 20);
  const batchSize = setting(env.YOUTUBE_AUTO_PLAYLIST_BATCH_SIZE, 20, 50);
  const reviewPlaylistTitle = String(env.YOUTUBE_AUTO_PLAYLIST_REVIEW_TITLE || 'Needs Playlist Review')
    .trim().slice(0, 150) || 'Needs Playlist Review';
  const reviewPlaylistDescription = 'Private review queue for videos that did not confidently match an existing playlist. Video visibility remains unchanged.';
  let playlistsCache = null;
  let playlistsCacheAt = 0;

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

    try {
      const playlists = await getOwnedPlaylists();
      const selected = chooseAutoPlaylist({ ...video, id: videoId, privacyStatus }, playlists);
      let playlist = selected.playlist;
      const needsReview = !playlist;
      if (needsReview) {
        playlist = playlists.find((item) => item.privacyStatus === 'private' &&
          String(item.title || '').trim().toLowerCase() === reviewPlaylistTitle.toLowerCase()) || null;
        if (!playlist && typeof youtube.createPlaylist !== 'function') {
          return { state: selected.state, reason: selected.reason };
        }
      }

      const quotaBucket = playlist?.privacyStatus === 'public' ? 'public' : 'private';
      const slot = await store.reservePlaylistAutoSlot(quotaBucket, dailyLimit, youtubeQuotaDate(now()));
      if (!slot?.allowed) return { state: 'daily_limit', privacyStatus: quotaBucket, limit: dailyLimit };

      if (!playlist) {
        playlist = await youtube.createPlaylist({
          title: reviewPlaylistTitle,
          description: reviewPlaylistDescription,
          privacyStatus: 'private'
        });
        playlists.push(playlist);
      }

      const result = await youtube.addVideoToPlaylist({ playlistId: playlist.id, videoId });
      return {
        state: needsReview
          ? (result.alreadyAdded ? 'fallback_already_added' : 'fallback_added')
          : (result.alreadyAdded ? 'already_added' : 'added'),
        playlistId: playlist.id,
        playlistTitle: playlist.title,
        privacyStatus: playlist.privacyStatus || 'private',
        score: selected.score,
        ...(needsReview ? { needsReview: true, matchState: selected.state, reason: selected.reason } : {})
      };
    } catch (error) {
      logger.warn?.('Automatic playlist assignment failed for ' + videoId + ': ' + error.message);
      return { state: 'retry', reason: String(error.message || 'YouTube request failed').slice(0, 300),
        at: new Date(now()).toISOString() };
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
    const candidates = await store.listSeoNeedsPlaylist(batchSize);
    let attempted = 0;
    let assigned = 0;
    for (const candidate of candidates || []) {
      const result = await assign({
        ...(candidate.source || {}),
        id: candidate.videoId,
        context: candidate.context || {},
        package: candidate.package || null
      });
      if (result.state === 'daily_limit') break;
      attempted += 1;
      if (['added', 'already_added', 'fallback_added', 'fallback_already_added'].includes(result.state)) assigned += 1;
      await store.markSeoPlaylistResult(candidate.videoId, result);
    }
    return { attempted, assigned };
  }

  return { enabled, dailyLimit, assign, assignCatalogBacklog, auditCatalogCoverage, reconcilePlaylistCoverage,
    assignPublicBacklog: assignCatalogBacklog,
    invalidatePlaylists: () => { playlistsCache = null; playlistsCacheAt = 0; } };
}

module.exports = { createPlaylistAutoAssigner, youtubeQuotaDate };
