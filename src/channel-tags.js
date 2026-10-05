'use strict';

const CREATOR_TAG = '@saevond';
const MAX_YOUTUBE_TAG_CHARACTERS = 500;
const VIDEO_PRIVACY_STATUSES = new Set(['public', 'private', 'unlisted']);

function youtubeTagCharacters(tags) {
  const values = (Array.isArray(tags) ? tags : [])
    .filter((tag) => typeof tag === 'string' && tag.trim())
    .map((tag) => tag.trim());
  return values.reduce((total, tag) => total + Array.from(tag).length + (/\s/u.test(tag) ? 2 : 0), 0) +
    Math.max(0, values.length - 1);
}

function ensureCreatorTag(rawTags, { maxCharacters = MAX_YOUTUBE_TAG_CHARACTERS,
  maxTags = Infinity, trimOverflow = false } = {}) {
  if (!Array.isArray(rawTags)) throw new TypeError('Video tags must be an array');
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < CREATOR_TAG.length) {
    throw new Error('Invalid YouTube tag character limit');
  }
  if (!(maxTags === Infinity || Number.isSafeInteger(maxTags) && maxTags >= 1)) {
    throw new Error('Invalid YouTube tag count limit');
  }

  const sourceTags = rawTags.filter((tag) => typeof tag === 'string' && tag.trim())
    .map((tag) => tag.trim());
  const creatorTagIndex = sourceTags.findIndex((tag) => {
    const normalized = tag.toLocaleLowerCase();
    return normalized === CREATOR_TAG || normalized === 'saevond';
  });
  const tags = sourceTags.filter((tag) => {
    const normalized = tag.toLocaleLowerCase();
    return normalized !== CREATOR_TAG && normalized !== 'saevond';
  });
  const creatorInsertIndex = creatorTagIndex < 0 ? tags.length :
    sourceTags.slice(0, creatorTagIndex).filter((tag) => {
      const normalized = tag.toLocaleLowerCase();
      return normalized !== CREATOR_TAG && normalized !== 'saevond';
    }).length;
  tags.splice(creatorInsertIndex, 0, CREATOR_TAG);

  const fits = () => tags.length <= maxTags && youtubeTagCharacters(tags) <= maxCharacters;
  while (!fits() && trimOverflow) {
    let removeIndex = tags.length - 1;
    while (removeIndex >= 0 && tags[removeIndex].toLocaleLowerCase() === CREATOR_TAG) removeIndex -= 1;
    if (removeIndex < 0) break;
    tags.splice(removeIndex, 1);
  }
  if (!fits()) {
    throw new Error('Cannot add @saevond within the YouTube tag limits without removing existing tags');
  }
  return tags;
}

function buildCreatorTagUpdate(video, channelId, options = {}) {
  const id = String(video?.id || '');
  const snippet = video?.snippet || {};
  const privacyStatus = video?.status?.privacyStatus;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('A valid YouTube video ID is required');
  if (!channelId || snippet.channelId !== channelId) {
    const error = new Error('Video is not owned by the target YouTube channel');
    error.status = 403;
    throw error;
  }
  if (!VIDEO_PRIVACY_STATUSES.has(privacyStatus)) {
    const error = new Error('Video has an unsupported privacy status');
    error.status = 403;
    throw error;
  }
  if (!video.etag) {
    const error = new Error('YouTube did not return a video version; refresh before saving');
    error.status = 409;
    throw error;
  }
  if (typeof snippet.title !== 'string' || !snippet.title || !snippet.categoryId) {
    const error = new Error('YouTube video title and category are required for a snippet update');
    error.status = 409;
    throw error;
  }

  const tags = ensureCreatorTag(snippet.tags || [], {
    maxCharacters: options.maxCharacters || MAX_YOUTUBE_TAG_CHARACTERS,
    trimOverflow: true
  });
  const changed = JSON.stringify(tags) !== JSON.stringify(snippet.tags || []);
  const requestBody = {
    id,
    snippet: {
      title: snippet.title,
      description: typeof snippet.description === 'string' ? snippet.description : '',
      categoryId: snippet.categoryId,
      tags
    }
  };
  if (snippet.defaultLanguage) requestBody.snippet.defaultLanguage = snippet.defaultLanguage;
  if (snippet.defaultAudioLanguage) requestBody.snippet.defaultAudioLanguage = snippet.defaultAudioLanguage;

  return { changed, requestBody, etag: video.etag, tags, privacyStatus };
}

function isYouTubeAuthorizationError(error) {
  const apiError = error?.response?.data?.error || {};
  const reason = (apiError.errors || []).map((item) => item?.reason || '').join(' ');
  const text = [error?.code, error?.status, apiError.status, apiError.message, reason, error?.message]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return /invalid_grant|invalid credentials|refresh token.{0,30}(expired|revoked|invalid)|(?:expired|revoked).{0,30}refresh token/.test(text);
}

module.exports = {
  CREATOR_TAG,
  MAX_YOUTUBE_TAG_CHARACTERS,
  VIDEO_PRIVACY_STATUSES,
  youtubeTagCharacters,
  ensureCreatorTag,
  buildCreatorTagUpdate,
  isYouTubeAuthorizationError
};
