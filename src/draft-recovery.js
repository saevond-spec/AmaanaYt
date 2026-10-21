'use strict';

function isYouTubeUploadLimitError(error) {
  const apiError = error?.response?.data?.error;
  const reasons = Array.isArray(apiError?.errors)
    ? apiError.errors.map((item) => item?.reason) : [];
  const detail = [error?.reason, error?.code, error?.message, apiError?.status,
    apiError?.message, ...reasons].filter(Boolean).join(' ').toLowerCase();
  return /uploadlimitexceeded|daily.?limit.?exceeded.{0,80}upload|upload.{0,80}daily.?limit/.test(detail);
}

async function recoverInterruptedYouTubeUploads(drafts, updateDraft, onError = () => {}) {
  if (!Array.isArray(drafts) || typeof updateDraft !== 'function') {
    throw new TypeError('Drafts and an update function are required');
  }
  const replacements = new Map();
  for (const draft of drafts) {
    if (draft?.sourceType !== 'twitch_vod' || draft.status !== 'uploading_private_to_youtube') continue;
    const patch = draft.youtubeVideoId
      ? { status: 'awaiting_owner_approval', productionState: 'ready',
          error: null, nextClipAttemptAt: null }
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

module.exports = { isYouTubeUploadLimitError, recoverInterruptedYouTubeUploads };
