'use strict';

const { CHANNEL_MINIMUM_VIEWS, summarizeYoutubeVideoQuality } = require('./youtube-video-quality');
const { isYouTubeAuthorizationError } = require('./channel-tags');
const { VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS, LEGACY_VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS } = require('./highlight-validation');
const ACCEPTED_GAMEPLAY_HIGHLIGHT_SECONDS = new Set([
  VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS,
  LEGACY_VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS
]);

const QUALITY_WINDOW_DAYS = 7;
const REPORTING_DELAY_DAYS = 3;
const DEFAULT_BATCH_SIZE = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function youtubeAnalyticsDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid date is required');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return fields.year + '-' + fields.month + '-' + fields.day;
}

function shiftDays(value, amount) {
  const date = new Date(value + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function qualityWindow(publishedAt, now = new Date()) {
  const published = new Date(publishedAt);
  const timestamp = new Date(now);
  if (!Number.isFinite(published.getTime()) || !Number.isFinite(timestamp.getTime())) return null;
  // Exclude the partial publication date so every highlight is compared on seven complete Analytics dates.
  const startDate = shiftDays(youtubeAnalyticsDate(published), 1);
  const endDate = shiftDays(startDate, QUALITY_WINDOW_DAYS - 1);
  const latestCompleteEnd = shiftDays(youtubeAnalyticsDate(timestamp), -REPORTING_DELAY_DAYS);
  return endDate <= latestCompleteEnd ? { startDate, endDate } : null;
}

function cleanError(error) {
  return String(error?.message || 'YouTube Analytics request failed')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}

function isPublishedHighlight(draft) {
  const targetDuration = Number(draft && draft.targetHighlightDurationSeconds);
  const duration = Number(draft && draft.duration);
  return draft?.sourceType === 'twitch_highlight_batch' &&
    ACCEPTED_GAMEPLAY_HIGHLIGHT_SECONDS.has(targetDuration) &&
    duration === targetDuration &&
    draft.publicationStatus === 'published' &&
    /^[A-Za-z0-9_-]{11}$/.test(String(draft.youtubeVideoId || '')) &&
    Number.isFinite(Date.parse(draft.publishedAt || ''));
}

function isDueForQualityCheck(draft, timestamp) {
  if (!isPublishedHighlight(draft) || !qualityWindow(draft.publishedAt, timestamp)) return false;
  const nowMs = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  if (!Number.isFinite(nowMs)) return false;
  const retryAfter = Date.parse(draft.youtubeQualityRetryAfter || '');
  if (Number.isFinite(retryAfter)) return retryAfter <= nowMs;
  const lastCheck = Date.parse(draft.youtubeQualityLastCheckedAt || '');
  if (!Number.isFinite(lastCheck)) return true;
  const assessment = draft.youtubeQualityAssessment;
  const interval = assessment?.relativeRetentionScore !== null &&
    assessment?.relativeRetentionScore !== undefined ? 28 * DAY_MS : 7 * DAY_MS;
  return nowMs - lastCheck >= interval;
}

function channelHistory(drafts, beforePublishedAt, targetDuration) {
  const cutoff = Date.parse(beforePublishedAt || '');
  return drafts.filter((draft) => isPublishedHighlight(draft) &&
    Number(draft.targetHighlightDurationSeconds) === Number(targetDuration) &&
    Date.parse(draft.publishedAt) < cutoff && draft.youtubeQualityAssessment)
    .map((draft) => ({
      publishedAt: draft.publishedAt,
      averageViewPercentage: draft.youtubeQualityAssessment.averageViewPercentage,
      views: draft.youtubeQualityAssessment.assessedViews
    }))
    .filter((item) => item.averageViewPercentage !== null && item.averageViewPercentage !== undefined &&
      item.averageViewPercentage !== '' && Number.isFinite(Number(item.averageViewPercentage)) &&
      Number(item.views) >= CHANNEL_MINIMUM_VIEWS)
    .sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt));
}

async function runYoutubeQualityAutopilot({ store, youtube, state = {}, now = new Date(),
  logger = console, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('A valid quality autopilot date is required');
  const today = timestamp.toISOString().slice(0, 10);
  if (typeof youtube?.hasAnalyticsReadAccess !== 'function' || !await youtube.hasAnalyticsReadAccess()) {
    return { state, status: 'needs_youtube_analytics_consent', updatedCount: 0, failedCount: 0 };
  }
  if (state.youtubeQualityAnalyticsNeedsReconnect === true) {
    return { state, status: 'needs_youtube_reconnect', updatedCount: 0, failedCount: 0 };
  }
  if (state.youtubeQualityAnalyticsRunDate === today) {
    return { state, status: 'already_ran_today', updatedCount: 0, failedCount: 0 };
  }
  const retryAfter = Date.parse(state.youtubeQualityAnalyticsRetryAfter || '');
  if (Number.isFinite(retryAfter) && retryAfter > timestamp.getTime()) {
    return { state, status: 'cooldown', updatedCount: 0, failedCount: 0 };
  }
  if (typeof store?.listDrafts !== 'function' || typeof store?.updateDraft !== 'function' ||
      typeof store?.saveSeoSyncState !== 'function' || typeof youtube?.videoQualityReports !== 'function') {
    return { state, status: 'not_configured', updatedCount: 0, failedCount: 0 };
  }

  const drafts = await store.listDrafts();
  const candidates = drafts.filter((draft) => isDueForQualityCheck(draft, timestamp.getTime()))
    .sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt));
  const configuredBatch = Number.isSafeInteger(batchSize) ? batchSize : DEFAULT_BATCH_SIZE;
  const limit = Math.max(1, Math.min(25, configuredBatch));
  const selected = candidates.slice(0, limit);
  const errors = [];
  let updatedCount = 0;
  let reconnectRequired = false;

  for (const draft of selected) {
    const window = qualityWindow(draft.publishedAt, timestamp);
    if (!window) continue;
    try {
      const report = await youtube.videoQualityReports(draft.youtubeVideoId, window.startDate, window.endDate);
      const assessment = summarizeYoutubeVideoQuality(report?.summaryRows, report?.retentionRows, {
        durationSeconds: Number(draft.targetHighlightDurationSeconds),
        history: channelHistory(drafts, draft.publishedAt, draft.targetHighlightDurationSeconds)
      });
      await store.updateDraft(draft.id, {
        youtubeQualityAssessment: {
          ...assessment,
          windowDays: QUALITY_WINDOW_DAYS,
          windowStart: window.startDate,
          windowEnd: window.endDate,
          checkedAt: timestamp.toISOString()
        },
        youtubeQualityLastCheckedAt: timestamp.toISOString(),
        youtubeQualityLastError: null,
        youtubeQualityRetryAfter: null
      });
      draft.youtubeQualityAssessment = {
        ...assessment,
        windowDays: QUALITY_WINDOW_DAYS,
        windowStart: window.startDate,
        windowEnd: window.endDate,
        checkedAt: timestamp.toISOString()
      };
      draft.youtubeQualityLastCheckedAt = timestamp.toISOString();
      draft.youtubeQualityRetryAfter = null;
      updatedCount += 1;
    } catch (error) {
      const message = cleanError(error);
      errors.push(String(draft.youtubeVideoId) + ': ' + message);
      logger.warn?.('YouTube video quality analytics failed for ' + draft.youtubeVideoId + ': ' + message);
      if (isYouTubeAuthorizationError(error)) {
        reconnectRequired = true;
        break;
      }
      await store.updateDraft(draft.id, {
        youtubeQualityLastError: message,
        youtubeQualityRetryAfter: new Date(timestamp.getTime() + 6 * 60 * 60 * 1000).toISOString()
      });
      draft.youtubeQualityRetryAfter = new Date(timestamp.getTime() + 6 * 60 * 60 * 1000).toISOString();
    }
  }

  const allFailed = selected.length > 0 && updatedCount === 0;
  const updatedState = {
    ...state,
    youtubeQualityAnalyticsAttempted: selected.length,
    youtubeQualityAnalyticsUpdated: updatedCount,
    youtubeQualityAnalyticsFailed: errors.length,
    youtubeQualityAnalyticsLastAttemptAt: timestamp.toISOString(),
    youtubeQualityAnalyticsLastError: errors.length ? errors.slice(0, 3).join(' | ').slice(0, 700) : null,
    youtubeQualityAnalyticsNeedsReconnect: reconnectRequired,
    youtubeQualityAnalyticsRetryAfter: reconnectRequired ? null : allFailed
      ? new Date(timestamp.getTime() + 6 * 60 * 60 * 1000).toISOString() : null,
    ...(allFailed || reconnectRequired ? {} : { youtubeQualityAnalyticsRunDate: today })
  };
  await store.saveSeoSyncState(updatedState);
  logger.info?.('YouTube video quality autopilot: assessed ' + updatedCount + '/' +
    selected.length + ' mature gameplay highlights');
  return {
    state: updatedState,
    status: reconnectRequired ? 'needs_youtube_reconnect' : allFailed ? 'retry_scheduled' : 'complete',
    attemptedCount: selected.length,
    updatedCount,
    failedCount: errors.length,
    matureCandidateCount: candidates.length
  };
}

module.exports = {
  QUALITY_WINDOW_DAYS,
  REPORTING_DELAY_DAYS,
  qualityWindow,
  isDueForQualityCheck,
  channelHistory,
  runYoutubeQualityAutopilot
};
