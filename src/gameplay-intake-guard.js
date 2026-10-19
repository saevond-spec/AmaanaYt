'use strict';

const PLACEHOLDER_TEST_TITLES = new Set([
  'test', 'testing', 'stream test', 'test stream', 'live test', 'test live',
  'vod test', 'test vod', 'clip test', 'test clip'
]);

function normalizeTitle(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isPlaceholderTestTitle(value) {
  return PLACEHOLDER_TEST_TITLES.has(normalizeTitle(value));
}

function isNonGameplayTestClip({ clipTitle, streamTitle } = {}) {
  if (isPlaceholderTestTitle(streamTitle) || isPlaceholderTestTitle(clipTitle)) return true;
  const normalizedClip = normalizeTitle(clipTitle);
  return /^(?:wzbot|wizebot) clip test\b/.test(normalizedClip);
}

function collectTestVodDrafts(drafts, rootDraftId) {
  if (!Array.isArray(drafts)) return [];
  const root = drafts.find((draft) => String(draft && draft.id || '') === String(rootDraftId || ''));
  if (!root || root.sourceType !== 'twitch_highlight_batch' ||
      !String(root.vodId || '').trim() || !isPlaceholderTestTitle(root.streamTitle)) return [];

  const vodId = String(root.vodId);
  const batchIds = new Set(drafts.filter((draft) =>
    draft && draft.sourceType === 'twitch_highlight_batch' &&
    String(draft.vodId || '') === vodId
  ).map((draft) => String(draft.id)));
  return drafts.filter((draft) => draft && (
    batchIds.has(String(draft.id)) ||
    draft.sourceType === 'twitch_vod' && String(draft.vodId || '') === vodId ||
    draft.sourceType === 'twitch_highlight_short' && batchIds.has(String(draft.parentId || ''))
  ));
}

function hasProtectedPublication(drafts) {
  return (Array.isArray(drafts) ? drafts : []).some((draft) =>
    draft && (
      draft.status === 'published' || draft.status === 'scheduled' ||
      draft.publicationStatus === 'published' || draft.publicationStatus === 'scheduled' ||
      draft.youtubePrivacyStatus === 'public'
    ));
}

module.exports = {
  isPlaceholderTestTitle,
  isNonGameplayTestClip,
  collectTestVodDrafts,
  hasProtectedPublication
};
