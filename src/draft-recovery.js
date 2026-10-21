'use strict';

const YOUTUBE_UPLOAD_LIMIT_RETRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TWITCH_VOD_MAX_ATTEMPTS = 8;
const DEFAULT_HIGHLIGHT_MAX_ATTEMPTS = 12;
const DEFAULT_HIGHLIGHT_RETRY_LEASE_MS = 15 * 60 * 1000;
const RECOVERABLE_YOUTUBE_UPLOAD_TYPES = new Set([
  'twitch_vod', 'twitch_highlight_batch', 'twitch_highlight_short'
]);

function computeRetryDelayMs({ attempt = 1, baseDelayMs = 60000, maxDelayMs = 30 * 60 * 1000,
  minimumDelayMs = 1000, providerRetryAfterMs = 0, seed = '' } = {}) {
  const attemptNumber = Number.isFinite(Number(attempt)) ? Math.max(1, Math.floor(Number(attempt))) : 1;
  const base = Number.isFinite(Number(baseDelayMs)) ? Math.max(0, Number(baseDelayMs)) : 60000;
  const maximum = Number.isFinite(Number(maxDelayMs)) ? Math.max(0, Number(maxDelayMs)) : 30 * 60 * 1000;
  const exponent = Math.min(30, attemptNumber - 1);
  const cap = Math.min(maximum, base * (2 ** exponent));
  let hash = 2166136261;
  for (const character of String(seed) + ':' + attemptNumber) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const unit = (hash >>> 0) / 0xffffffff;
  const jittered = Math.floor(cap / 2 + unit * cap / 2);
  const minimum = Number.isFinite(Number(minimumDelayMs)) ? Math.max(0, Number(minimumDelayMs)) : 1000;
  const providerDelay = Number.isFinite(Number(providerRetryAfterMs))
    ? Math.max(0, Number(providerRetryAfterMs)) : 0;
  return Math.max(minimum, jittered, providerDelay);
}

function isYouTubeUploadLimitError(error) {
  const apiError = error?.response?.data?.error;
  const reasons = Array.isArray(apiError?.errors)
    ? apiError.errors.map((item) => item?.reason) : [];
  const detail = [error?.reason, error?.code, error?.message, apiError?.status,
    apiError?.message, ...reasons].filter(Boolean).join(' ').toLowerCase();
  return /uploadlimitexceeded|daily.?limit.?exceeded.{0,80}upload|upload.{0,80}daily.?limit/.test(detail);
}

function youtubeUploadHttpStatus(error) {
  const candidates = [
    error?.response?.status,
    error?.status,
    error?.statusCode,
    error?.response?.data?.error?.code
  ];
  for (const value of candidates) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return null;
}

// A structured 4xx response confirms that YouTube rejected the insert. Network
// errors and server-side 5xx responses remain ambiguous because YouTube may have
// accepted the upload before the client lost the response.
function isDefiniteYouTubeUploadRejection(error) {
  const status = youtubeUploadHttpStatus(error);
  return status !== null && status >= 400 && status < 500;
}


function isRetryableYouTubeUploadRejection(error) {
  const status = youtubeUploadHttpStatus(error);
  return status === 408 || status === 425 || status === 429;
}

function isUploadRetryCoolingDown(draft, now = Date.now()) {
  if (draft?.status !== 'clip_retry_wait') return false;
  const retryAt = Date.parse(draft.nextClipAttemptAt || '');
  return Number.isFinite(retryAt) && retryAt > Number(now);
}

function canRetryTwitchDraft(draft, now = Date.now()) {
  if (!draft || !['twitch_vod', 'twitch_highlight_batch'].includes(draft.sourceType) ||
      ['excluded_by_owner', 'completed', 'clip_upload_uncertain',
        'uploading_private_to_youtube'].includes(draft.status) ||
      draft.productionState === 'published' || draft.publicationStatus === 'published' ||
      isUploadRetryCoolingDown(draft, now)) return false;
  return ['clip_failed', 'clip_partial', 'clip_retry_wait'].includes(draft.status);
}

function isOwnedPrivateYouTubeVideo(video, channel, expectedVideoId) {
  return Boolean(video && channel && expectedVideoId &&
    video.id === expectedVideoId &&
    video.snippet?.channelId &&
    video.snippet.channelId === channel.id &&
    video.status?.privacyStatus === 'private');
}

function buildUploadReconciliationPatch(draft, { youtubeVideoId, confirmNoUpload } = {}, now = Date.now()) {
  if (!draft || draft.status !== 'clip_upload_uncertain' ||
      !RECOVERABLE_YOUTUBE_UPLOAD_TYPES.has(draft.sourceType)) {
    throw new Error('Only an uncertain Twitch upload can be reconciled');
  }
  const common = {
    error: null, productionFailures: [], nextClipAttemptAt: null,
    manualReconciledAt: new Date(Number(now)).toISOString()
  };
  if (youtubeVideoId) {
    const state = draft.sourceType === 'twitch_highlight_batch'
      ? { status: 'creating_shorts', productionState: 'processing' }
      : draft.sourceType === 'twitch_highlight_short'
        ? { status: 'clip_partial', productionState: 'processing' }
        : { status: 'awaiting_owner_approval', productionState: 'ready' };
    return { ...common, ...state, youtubeVideoId: String(youtubeVideoId),
      manualReconciliationAction: 'private_video_attached' };
  }
  if (confirmNoUpload !== true || draft.youtubeVideoId) {
    throw new Error('Provide a verified private YouTube video ID or explicitly confirm that no matching upload exists');
  }
  return { ...common, status: 'clip_queued', productionState: 'queued',
    manualReconciliationAction: 'owner_confirmed_no_upload' };
}

function isDueRetryableHighlightShort(short, now = Date.now()) {
  return short?.sourceType === 'twitch_highlight_short' &&
    short.status === 'clip_retry_wait' &&
    (isYouTubeUploadLimitError({ message: short.error }) ||
      isRetryableYouTubeUploadRejection({ status: short.uploadRejectionStatus })) &&
    Number.isFinite(Date.parse(short.nextClipAttemptAt || '')) &&
    Date.parse(short.nextClipAttemptAt) <= Number(now);
}

function findDueTwitchHighlightRetryParents(drafts, now = Date.now(),
  maxAttempts = DEFAULT_HIGHLIGHT_MAX_ATTEMPTS) {
  if (!Array.isArray(drafts)) return [];
  const timestamp = Number(now);
  const attemptLimit = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts : DEFAULT_HIGHLIGHT_MAX_ATTEMPTS;
  const byId = new Map(drafts.map((draft) => [draft?.id, draft]));
  const parentIds = new Set();
  for (const short of drafts) {
    if (!isDueRetryableHighlightShort(short, timestamp)) continue;
    const parent = byId.get(short.parentId);
    const parentRetryAt = Date.parse(parent?.nextClipAttemptAt || '');
    const retryLeaseUntil = Date.parse(parent?.retryLeaseUntil || '');
    if (!parent || parent.sourceType !== 'twitch_highlight_batch' ||
        !parent.youtubeVideoId ||
        !['clip_partial', 'clip_retry_wait'].includes(parent.status) ||
        Number(parent.clipAttemptCount) >= attemptLimit ||
        Number.isFinite(parentRetryAt) && parentRetryAt > timestamp ||
        Number.isFinite(retryLeaseUntil) && retryLeaseUntil > timestamp) continue;
    parentIds.add(parent.id);
  }
  return drafts.filter((draft) => parentIds.has(draft?.id));
}

async function claimDueTwitchHighlightRetryParents(drafts, updateDraft, options = {}) {
  if (!Array.isArray(drafts) || typeof updateDraft !== 'function') {
    throw new TypeError('Drafts and an update function are required to claim retry parents');
  }
  const timestamp = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const leaseMs = Number.isFinite(Number(options.leaseMs)) && Number(options.leaseMs) > 0
    ? Number(options.leaseMs) : DEFAULT_HIGHLIGHT_RETRY_LEASE_MS;
  const candidates = findDueTwitchHighlightRetryParents(drafts, timestamp, options.maxAttempts);
  const claimed = new Set();
  const leaseUntil = new Date(timestamp + leaseMs).toISOString();
  for (const parent of candidates) {
    try {
      const updated = await updateDraft(parent.id, {
        retryLeaseUntil: leaseUntil,
        retryLeaseClaimedAt: new Date(timestamp).toISOString()
      });
      if (updated === null || updated === false) continue;
      claimed.add(parent.id);
    } catch (error) {
      if (typeof options.onError === 'function') options.onError(error, parent);
    }
  }
  return drafts.filter((draft) => claimed.has(draft?.id));
}

function findDueTwitchVodRetries(drafts, now = Date.now(),
  maxAttempts = DEFAULT_TWITCH_VOD_MAX_ATTEMPTS) {
  if (!Array.isArray(drafts)) return [];
  const attemptLimit = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts : DEFAULT_TWITCH_VOD_MAX_ATTEMPTS;
  return drafts.filter((draft) => draft?.sourceType === 'twitch_vod' &&
    draft.status === 'clip_retry_wait' &&
    Number(draft.clipAttemptCount || 0) < attemptLimit &&
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

module.exports = { isYouTubeUploadLimitError, isDefiniteYouTubeUploadRejection,
  isRetryableYouTubeUploadRejection, youtubeUploadHttpStatus,
  isUploadRetryCoolingDown, canRetryTwitchDraft,
  isOwnedPrivateYouTubeVideo, buildUploadReconciliationPatch,
  findDueTwitchVodRetries, findDueTwitchHighlightRetryParents,
  claimDueTwitchHighlightRetryParents, isDueRetryableHighlightShort,
  recoverInterruptedYouTubeUploads, YOUTUBE_UPLOAD_LIMIT_RETRY_MS,
  computeRetryDelayMs,
  DEFAULT_TWITCH_VOD_MAX_ATTEMPTS, DEFAULT_HIGHLIGHT_MAX_ATTEMPTS,
  DEFAULT_HIGHLIGHT_RETRY_LEASE_MS };
