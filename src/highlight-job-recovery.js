'use strict';

const RESUMABLE_TWITCH_CLIP_STATUSES = new Set([
  'clip_queued',
  'creating_twitch_clip',
  'waiting_for_clip_media',
  'downloading_twitch_clip',
  'formatting_vertical_short',
  'uploading_private_to_youtube',
  'clip_retry_wait'
]);

const RESUMABLE_HIGHLIGHT_BATCH_STATUSES = new Set([
  'clip_queued',
  'creating_twitch_clips',
  'assembling_highlight_video',
  'creating_shorts',
  'uploading_private_to_youtube'
]);

function resumableTwitchClipDrafts(drafts, now = Date.now()) {
  const timestamp = Number(now);
  return (Array.isArray(drafts) ? drafts : []).filter((draft) => {
    if (draft?.sourceType !== 'twitch_vod' || !RESUMABLE_TWITCH_CLIP_STATUSES.has(draft.status)) {
      return false;
    }
    if (draft.status !== 'clip_retry_wait') return true;
    const retryAt = Date.parse(draft.nextClipAttemptAt || '');
    return Number.isFinite(timestamp) && Number.isFinite(retryAt) && retryAt <= timestamp;
  });
}

function resumableHighlightBatchDrafts(drafts) {
  return (Array.isArray(drafts) ? drafts : []).filter((draft) =>
    draft?.sourceType === 'twitch_highlight_batch' &&
    RESUMABLE_HIGHLIGHT_BATCH_STATUSES.has(draft.status));
}

module.exports = { resumableTwitchClipDrafts, resumableHighlightBatchDrafts };
