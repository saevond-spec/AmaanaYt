'use strict';

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizePlaylistInput(input = {}) {
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  const privacyStatus = String(input.privacyStatus || 'private').trim().toLowerCase();
  if (!title || title.length > 150) throw inputError('Playlist title must contain 1–150 characters');
  if (description.length > 5000) throw inputError('Playlist description must be at most 5,000 characters');
  if (!['private', 'unlisted', 'public'].includes(privacyStatus)) {
    throw inputError('Playlist privacy must be private, unlisted, or public');
  }
  return { title, description, privacyStatus };
}

function canAddVideoToPlaylist(videoPrivacyStatus, playlistPrivacyStatus) {
  if (videoPrivacyStatus === 'public') return ['private', 'unlisted', 'public'].includes(playlistPrivacyStatus);
  if (['private', 'unlisted'].includes(videoPrivacyStatus)) return playlistPrivacyStatus === 'private';
  return false;
}

function createYouTubePlaylistClient(getService) {
  if (typeof getService !== 'function') throw new TypeError('A YouTube service factory is required');

  async function listOwnedPlaylists() {
    const youtube = await getService();
    const playlists = [];
    let pageToken = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await youtube.playlists.list({
        part: ['snippet', 'status'], mine: true, maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
        fields: 'nextPageToken,items(id,snippet(title,description),status(privacyStatus))'
      });
      for (const item of response.data.items || []) {
        if (!item.id) continue;
        playlists.push({
          id: item.id, title: String(item.snippet?.title || ''),
          description: String(item.snippet?.description || ''),
          privacyStatus: item.status?.privacyStatus || 'private'
        });
      }
      if (!response.data.nextPageToken) break;
      pageToken = response.data.nextPageToken;
    }
    return playlists;
  }

  async function createPlaylist(input) {
    const playlist = normalizePlaylistInput(input);
    const youtube = await getService();
    const response = await youtube.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: playlist.title, description: playlist.description },
        status: { privacyStatus: playlist.privacyStatus }
      }
    });
    const item = response.data || {};
    if (!item.id) throw new Error('YouTube did not return the new playlist ID');
    return { id: item.id, title: item.snippet?.title || playlist.title,
      description: item.snippet?.description || playlist.description,
      privacyStatus: item.status?.privacyStatus || playlist.privacyStatus };
  }

  async function addVideoToPlaylist({ playlistId, videoId } = {}) {
    const targetPlaylistId = String(playlistId || '').trim();
    const targetVideoId = String(videoId || '').trim();
    if (!targetPlaylistId || targetPlaylistId.length > 255) throw inputError('A valid playlist ID is required');
    if (!/^[A-Za-z0-9_-]{11}$/.test(targetVideoId)) throw inputError('A valid 11-character YouTube video ID is required');
    const youtube = await getService();
    const existing = await youtube.playlistItems.list({
      part: ['snippet'], playlistId: targetPlaylistId, videoId: targetVideoId, maxResults: 1,
      fields: 'items(id,snippet(resourceId(videoId)))'
    });
    const match = (existing.data.items || []).find((item) => item.snippet?.resourceId?.videoId === targetVideoId);
    if (match) return { alreadyAdded: true, itemId: match.id || null };
    const inserted = await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: { snippet: { playlistId: targetPlaylistId,
        resourceId: { kind: 'youtube#video', videoId: targetVideoId } } }
    });
    return { alreadyAdded: false, itemId: inserted.data?.id || null };
  }

  return { listOwnedPlaylists, createPlaylist, addVideoToPlaylist };
}

module.exports = { normalizePlaylistInput, canAddVideoToPlaylist, createYouTubePlaylistClient };
