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


const GENERIC_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'best', 'by', 'clip', 'clips', 'content', 'episode',
  'episodes', 'game', 'games', 'gaming', 'gameplay', 'highlight', 'highlights', 'in',
  'live', 'livestream', 'moment', 'moments', 'of', 'official', 'part', 'playthrough',
  'saevond', 'series', 'short', 'shorts', 'stream', 'the', 'video', 'videos'
]);
const FORMAT_WORDS = new Set([
  'clip', 'clips', 'highlight', 'highlights', 'live', 'livestream', 'short', 'shorts',
  'stream', 'tutorial', 'guide', 'review', 'vod', 'walkthrough'
]);

function words(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function meaningfulWords(value) {
  return words(value).filter((word) => !GENERIC_WORDS.has(word) && !/^\d+$/.test(word));
}

function metadataFields(video = {}) {
  const source = video.source || video;
  const context = video.context || {};
  const snippet = video.snippet || {};
  const seoPackage = video.package || video.seoPackage || {};
  const tags = [video.tags, source.tags, snippet.tags].flat()
    .filter((value) => typeof value === 'string').join(' ');
  return {
    strong: [
      video.title || snippet.title || source.title || '',
      tags,
      [video.topic, video.primaryKeyword, context.topic, context.primaryKeyword,
        seoPackage.primaryKeyword].filter(Boolean).join(' ')
    ],
    supporting: [
      video.description || snippet.description || source.description || '',
      [context.takeaways, context.audience, context.videoType, video.videoType].filter(Boolean).join(' ')
    ]
  };
}

function chooseAutoPlaylist(video = {}, playlists = []) {
  const videoPrivacy = video.privacyStatus || video.status?.privacyStatus || video.source?.privacyStatus;
  if (!['public', 'private', 'unlisted'].includes(videoPrivacy)) {
    return { state: 'ineligible', playlist: null, reason: 'unknown_video_privacy' };
  }

  const fields = metadataFields(video);
  const strongWords = new Set(fields.strong.flatMap(words));
  const allWords = new Set([...strongWords, ...fields.supporting.flatMap(words)]);
  const candidates = [];
  for (const playlist of playlists) {
    if (!playlist?.id || !canAddVideoToPlaylist(videoPrivacy, playlist.privacyStatus)) continue;
    const titleIdentity = meaningfulWords(playlist.title);
    const descriptionIdentity = meaningfulWords(playlist.description);
    const identity = titleIdentity.length ? titleIdentity : descriptionIdentity;
    if (!identity.length) continue;

    const isInStrongMetadata = identity.every((word) => strongWords.has(word));
    const isInAnyMetadata = identity.every((word) => allWords.has(word));
    if (!isInAnyMetadata) continue;

    let score = isInStrongMetadata ? 100 : 82;
    if (videoPrivacy === 'public') score += playlist.privacyStatus === 'public' ? 25
      : playlist.privacyStatus === 'unlisted' ? 10 : 0;
    const titleFormats = words(playlist.title).filter((word) => FORMAT_WORDS.has(word));
    if (titleFormats.length) {
      score += titleFormats.every((word) => allWords.has(word)) ? 25 : -25;
    }
    candidates.push({ playlist, score, identity: identity.join(' ') });
  }

  candidates.sort((left, right) => right.score - left.score);
  if (!candidates.length || candidates[0].score < 80) {
    return { state: 'no_match', playlist: null, reason: 'no_confident_metadata_match' };
  }
  if (candidates[1] && candidates[0].score - candidates[1].score < 20) {
    return { state: 'ambiguous', playlist: null, reason: 'multiple_playlists_match_metadata' };
  }
  return { state: 'matched', playlist: candidates[0].playlist, score: candidates[0].score };
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

module.exports = { normalizePlaylistInput, canAddVideoToPlaylist, chooseAutoPlaylist, createYouTubePlaylistClient };
