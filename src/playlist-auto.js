'use strict';

const { chooseAutoPlaylist } = require('./youtube-playlists');

function setting(value, fallback, cap) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, cap) : fallback;
}

function createPlaylistAutoAssigner({ store, youtube, env = process.env, logger = console, now = Date.now }) {
  if (!store || !youtube) throw new TypeError('Store and YouTube clients are required');
  const enabled = env.YOUTUBE_AUTO_PLAYLISTS !== 'false';
  const dailyLimit = setting(env.YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT, 20, 20);
  const batchSize = setting(env.YOUTUBE_AUTO_PLAYLIST_BATCH_SIZE, 20, 50);
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

    const slot = await store.reservePlaylistAutoSlot(privacyStatus, dailyLimit,
      new Date(now()).toISOString().slice(0, 10));
    if (!slot?.allowed) return { state: 'daily_limit', privacyStatus, limit: dailyLimit };

    try {
      const playlists = await getOwnedPlaylists();
      const selected = chooseAutoPlaylist({ ...video, id: videoId, privacyStatus }, playlists);
      if (!selected.playlist) return { state: selected.state, reason: selected.reason };
      const result = await youtube.addVideoToPlaylist({
        playlistId: selected.playlist.id, videoId
      });
      return {
        state: result.alreadyAdded ? 'already_added' : 'added',
        playlistId: selected.playlist.id,
        playlistTitle: selected.playlist.title,
        privacyStatus: selected.playlist.privacyStatus,
        score: selected.score
      };
    } catch (error) {
      logger.warn?.('Automatic playlist assignment failed for ' + videoId + ': ' + error.message);
      return { state: 'retry', reason: String(error.message || 'YouTube request failed').slice(0, 300),
        at: new Date(now()).toISOString() };
    }
  }

  async function assignPublicBacklog() {
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
        privacyStatus: 'public'
      });
      if (result.state === 'daily_limit') break;
      attempted += 1;
      if (result.state === 'added' || result.state === 'already_added') assigned += 1;
      await store.markSeoPlaylistResult(candidate.videoId, result);
    }
    return { attempted, assigned };
  }

  return { enabled, dailyLimit, assign, assignPublicBacklog,
    invalidatePlaylists: () => { playlistsCache = null; playlistsCacheAt = 0; } };
}

module.exports = { createPlaylistAutoAssigner };
