'use strict';

const YOUTUBE_UPLOAD_LIMIT_RETRY_MS = 24 * 60 * 60 * 1000;
const RECOVERABLE_YOUTUBE_UPLOAD_TYPES = new Set([
  'twitch_vod', 'twitch_highlight_batch', 'twitch_highlight_short'
]);

function isYouTubeUploadLimitError(error) {
  const apiError = error?.response?.data?.error;
  const reasons = Array.isArray(apiError?.errors)
    ? apiError.errors.map((item) => item?.reason) : [];
  const detail = [error?.reason, error?.code, error?.message, apiError?.status,
    apiError?.message, ...reasons].filter(Boolean).join(' ').toLowerCase();
  return /uploadlimitexceeded|daily.?limit.?exceeded.{0,80}upload|upload.{0,80}daily.?limit/.test(detail);
}

function findDueTwitchVodRetries(drafts, now = Date.now()) {
  if (!Array.isArray(drafts)) return [];
  return drafts.filter((draft) => draft?.sourceType === 'twitch_vod' &&
    draft.status === 'clip_retry_wait' &&
    Number.isFinite(Date.parse(draft.nextClipAttemptAt || '')) &&
    Date.parse(draft.nextClipAttemptAt) <= Number(now));
}

async function recoverInterruptedYouTubeUploads(drafts, updateDraft, onError = () => {}) {
  if (!Array.isArray(drafts) || typeof updateDraft !== 'function') {
    throw new TypeError('Drafts and an update function are required');
  }
  const replacements = new Map();
  for (const draft of drafts) {
    if (!RECOVERABLE_YOUTUBE_UPLOAD_TYPES.has(draft?.sourceType) ||
        draft.status !== 'uploading_private_to_youtube') continue;
    const completedState = draft.sourceType === 'twitch_highlight_batch'
      ? { status: 'creating_shorts', productionState: 'processing' }
      : draft.sourceType === 'twitch_highlight_short'
        ? { status: 'clip_partial', productionState: 'processing' }
        : { status: 'awaiting_owner_approval', productionState: 'ready' };
    const patch = draft.youtubeVideoId
      ? { ...completedState, error: null, nextClipAttemptAt: null }
      : { status: 'clip_upload_uncertain', productionState: 'manual_reconciliation',
          error: 'YouTube upload was interrupted before its video ID was saved. Check the channel for a private upload before retrying.',
          nextClipAttemptAt: null };
    let updated;
    try {
      updated = await updateDraft(draft.id, patch);
    } catch (error) {
      onError(error, draft);
    }
    // Exclude the locally normalized row from automatic resume even if persistence
    // failed; a subsequent boot will safely retry this reconciliation.
    replacements.set(draft.id, updated || { ...draft, ...patch });
  }
  return drafts.map((draft) => replacements.get(draft?.id) || draft);
}

module.exports = { isYouTubeUploadLimitError, YOUTUBE_UPLOAD_LIMIT_RETRY_MS,
  findDueTwitchVodRetries, recoverInterruptedYouTubeUploads };
