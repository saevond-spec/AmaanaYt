'use strict';

function asSeconds(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function parseTwitchDuration(value) {
  const match = String(value || '').trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match || !match[0]) throw new Error('Twitch returned an invalid VOD duration');
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Twitch returned an invalid VOD duration');
  return seconds;
}

function formatOffset(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function overlapRatio(left, right) {
  const overlap = Math.max(0, Math.min(left.endSeconds, right.endSeconds) -
    Math.max(left.startSeconds, right.startSeconds));
  return overlap / Math.min(left.duration, right.duration);
}

function requireArchivedTwitchVod(vod, expectedVodId, broadcasterId) {
  if (!vod) {
    const error = new Error('Twitch archive VOD is not available yet');
    error.status = 425;
    throw error;
  }
  if (String(vod.id || '') !== String(expectedVodId || '')) {
    const error = new Error('Twitch returned a different VOD than requested');
    error.status = 409;
    throw error;
  }
  if (String(vod.user_id || '') !== String(broadcasterId || '')) {
    const error = new Error('Twitch VOD does not belong to the connected broadcaster');
    error.status = 403;
    throw error;
  }
  if (vod.type !== 'archive') {
    const error = new Error('The supplied Twitch video is not an archived livestream VOD');
    error.status = 422;
    throw error;
  }
  try {
    parseTwitchDuration(vod.duration);
  } catch {
    const error = new Error('Twitch archive VOD does not have a valid finished duration');
    error.status = 422;
    throw error;
  }
  return vod;
}

const MAX_HIGHLIGHT_MOMENTS = 20;

function validateHighlightMoments(items, vodDurationSeconds) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('timestamps must contain at least one AI highlight');
  }
  if (items.length > MAX_HIGHLIGHT_MOMENTS) throw new Error('timestamps cannot contain more than 20 AI highlights');
  const vodDuration = asSeconds(vodDurationSeconds);
  if (!Number.isFinite(vodDuration) || vodDuration <= 0) {
    throw new Error('A measured Twitch VOD duration is required to validate timestamps');
  }

  const normalized = items.map((item, index) => {
    let start = asSeconds(item?.startSeconds);
    let end = asSeconds(item?.endSeconds ?? item?.vodOffset);
    const requestedDuration = asSeconds(item?.duration);
    if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(requestedDuration)) {
      end = start + requestedDuration;
    }
    if (!Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(requestedDuration)) {
      start = end - requestedDuration;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Highlight ${index + 1} has invalid startSeconds/endSeconds`);
    }
    const duration = end - start;
    if (duration < 5 || duration > 60) {
      throw new Error(`Highlight ${index + 1} must be between 5 and 60 seconds`);
    }
    if (end > vodDuration + 0.25) {
      throw new Error(`Highlight ${index + 1} ends after the Twitch VOD`);
    }
    const score = item?.score === null || item?.score === undefined || item?.score === ''
      ? null : asSeconds(item.score);
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
      throw new Error(`Highlight ${index + 1} has an invalid confidence score`);
    }
    const title = clean(item?.title, 100) || `Saevond highlight at ${formatOffset(end)}`;
    return {
      startSeconds: Number(start.toFixed(1)),
      endSeconds: Number(end.toFixed(1)),
      duration: Number(duration.toFixed(1)),
      title,
      reason: clean(item?.reason, 500),
      score
    };
  });

  const ranked = normalized.map((item, index) => ({ item, index }))
    .sort((left, right) => (right.item.score ?? 0) - (left.item.score ?? 0) || left.index - right.index);
  const selected = [];
  for (const candidate of ranked) {
    if (selected.some((existing) => overlapRatio(existing, candidate.item) >= 0.6 ||
        Math.abs(existing.endSeconds - candidate.item.endSeconds) < 3)) continue;
    selected.push(candidate.item);
  }
  return selected.slice(0, MAX_HIGHLIGHT_MOMENTS).sort((left, right) => left.startSeconds - right.startSeconds);
}

function verifyCreatedClip(moment, clip, vodId, toleranceSeconds = 2) {
  const actualVodId = String(clip?.video_id || '').trim();
  const actualOffset = asSeconds(clip?.vod_offset);
  const actualDuration = asSeconds(clip?.duration);
  if (actualVodId && actualVodId !== String(vodId)) {
    const error = new Error('Twitch clip metadata points to a different VOD than requested');
    error.status = 409;
    error.code = 'TWITCH_CLIP_WRONG_VOD';
    throw error;
  }
  if (!actualVodId || !Number.isFinite(actualOffset) || !Number.isFinite(actualDuration)) {
    const error = new Error('Twitch clip metadata is not linked to the requested VOD yet');
    error.status = 425;
    error.code = 'TWITCH_CLIP_METADATA_PENDING';
    throw error;
  }
  if (Math.abs(actualOffset - Number(moment.startSeconds)) > toleranceSeconds ||
      Math.abs(actualDuration - Number(moment.duration)) > 1) {
    const error = new Error('Twitch clip timestamps do not match the detected VOD moment');
    error.status = 422;
    throw error;
  }
  return {
    startSeconds: actualOffset,
    endSeconds: actualOffset + actualDuration,
    duration: actualDuration,
    verified: true
  };
}

function verifyClipCreationRequest(moment, clip, vodId, toleranceSeconds = 2) {
  const clipId = String(clip && clip.id || '').trim();
  const requestedVodId = String(clip && clip.requestedVodId || '').trim();
  const requestedOffset = asSeconds(clip && clip.requestedVodOffset);
  const requestedDuration = asSeconds(clip && clip.requestedDuration);
  if (requestedVodId && requestedVodId !== String(vodId)) {
    const error = new Error('Twitch clip request points to a different VOD than requested');
    error.status = 409;
    error.code = 'TWITCH_CLIP_WRONG_VOD';
    throw error;
  }
  if (!clipId || requestedVodId !== String(vodId) || !Number.isFinite(requestedOffset) ||
      !Number.isFinite(requestedDuration)) {
    const error = new Error('Amaana is missing the accepted Twitch VOD clip request details');
    error.status = 422;
    error.code = 'TWITCH_CLIP_REQUEST_UNVERIFIED';
    throw error;
  }
  const requestedStart = requestedOffset - requestedDuration;
  if (requestedStart < 0 || Math.abs(requestedStart - Number(moment.startSeconds)) > toleranceSeconds ||
      Math.abs(requestedDuration - Number(moment.duration)) > 1) {
    const error = new Error('Twitch VOD clip request does not match the detected highlight moment');
    error.status = 422;
    error.code = 'TWITCH_CLIP_REQUEST_MISMATCH';
    throw error;
  }
  return {
    sourceVodId: requestedVodId,
    startSeconds: requestedStart,
    endSeconds: requestedOffset,
    duration: requestedDuration,
    verified: true,
    verificationMethod: 'twitch_vod_clip_request'
  };
}

module.exports = {
  parseTwitchDuration, requireArchivedTwitchVod, validateHighlightMoments, MAX_HIGHLIGHT_MOMENTS,
  verifyCreatedClip, verifyClipCreationRequest
};
