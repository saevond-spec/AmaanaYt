const { youtubeSearchComparisonWindows } = require('./youtube-search-performance');
function cleanError(error) {
  return String(error?.message || 'YouTube Analytics request failed')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}
function safeCursor(value, total) {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 && total > 0 ? cursor % total : 0;
}
async function runYoutubeSearchAutopilot({ store, youtube, state = {}, now = new Date(),
  logger = console, batchSize = 20 }) {
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('A valid autopilot date is required');
  const today = timestamp.toISOString().slice(0, 10);
  if (typeof youtube?.hasAnalyticsReadAccess !== 'function' ||
      !await youtube.hasAnalyticsReadAccess()) {
    return { state, status: 'needs_youtube_analytics_consent', updatedCount: 0, failedCount: 0 };
  }
  if (state.youtubeSearchAnalyticsRunDate === today) {
    return { state, status: 'already_ran_today', updatedCount: 0, failedCount: 0 };
  }
  const retryAfter = Date.parse(state.youtubeSearchAnalyticsRetryAfter || '');
  if (Number.isFinite(retryAfter) && retryAfter > timestamp.getTime()) {
    return { state, status: 'cooldown', updatedCount: 0, failedCount: 0 };
  }
  if (typeof store.countPublicSeoVideos !== 'function' ||
      typeof store.listYoutubeSearchCandidates !== 'function' ||
      typeof store.saveYoutubeSearchSnapshots !== 'function' ||
      typeof store.saveSeoSyncState !== 'function') {
    return { state, status: 'not_configured', updatedCount: 0, failedCount: 0 };
  }
  const windows = youtubeSearchComparisonWindows(timestamp);
  const total = await store.countPublicSeoVideos();
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid public video count');
  if (total === 0) {
    const emptyState = {
      ...state, youtubeSearchAnalyticsCursor: 0, youtubeSearchAnalyticsAttempted: 0,
      youtubeSearchAnalyticsUpdated: 0, youtubeSearchAnalyticsFailed: 0,
      youtubeSearchAnalyticsPeriodStart: windows.current.startDate,
      youtubeSearchAnalyticsPeriodEnd: windows.current.endDate,
      youtubeSearchAnalyticsLastAttemptAt: timestamp.toISOString(),
      youtubeSearchAnalyticsLastError: null, youtubeSearchAnalyticsRetryAfter: null,
      youtubeSearchAnalyticsRunDate: today
    };
    await store.saveSeoSyncState(emptyState);
    return { state: emptyState, status: 'complete', updatedCount: 0, failedCount: 0, windows };
  }
  if (typeof youtube.googleSearchTraffic !== 'function') {
    return { state, status: 'not_configured', updatedCount: 0, failedCount: 0 };
  }
  const configuredBatch = Number.isSafeInteger(batchSize) ? batchSize : 20;
  const limit = Math.max(1, Math.min(50, configuredBatch));
  const offset = safeCursor(state.youtubeSearchAnalyticsCursor, total);
  const candidates = total ? await store.listYoutubeSearchCandidates(limit, offset) : [];
  const errors = [];
  let updatedCount = 0;
  for (const candidate of candidates) {
    const videoId = String(candidate?.videoId || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      errors.push('Skipped an invalid catalog video ID');
      continue;
    }
    try {
      const [current, previous] = await Promise.all([
        youtube.googleSearchTraffic(videoId, windows.current.startDate, windows.current.endDate),
        youtube.googleSearchTraffic(videoId, windows.previous.startDate, windows.previous.endDate)
      ]);
      await store.saveYoutubeSearchSnapshots([
        { videoId, ...windows.current, ...current },
        { videoId, ...windows.previous, ...previous }
      ]);
      updatedCount += 1;
    } catch (error) {
      errors.push(videoId + ': ' + cleanError(error));
      logger.warn?.('YouTube search analytics sync failed for ' + videoId + ': ' + cleanError(error));
    }
  }
  const failedCount = errors.length;
  const allFailed = candidates.length > 0 && updatedCount === 0;
  const nextCursor = total ? (offset + candidates.length) % total : 0;
  const updatedState = {
    ...state,
    youtubeSearchAnalyticsCursor: nextCursor,
    youtubeSearchAnalyticsAttempted: candidates.length,
    youtubeSearchAnalyticsUpdated: updatedCount,
    youtubeSearchAnalyticsFailed: failedCount,
    youtubeSearchAnalyticsPeriodStart: windows.current.startDate,
    youtubeSearchAnalyticsPeriodEnd: windows.current.endDate,
    youtubeSearchAnalyticsLastAttemptAt: timestamp.toISOString(),
    youtubeSearchAnalyticsLastError: failedCount ? errors.slice(0, 3).join(' | ').slice(0, 700) : null,
    youtubeSearchAnalyticsRetryAfter: allFailed
      ? new Date(timestamp.getTime() + 6 * 60 * 60 * 1000).toISOString() : null,
    ...(allFailed ? {} : { youtubeSearchAnalyticsRunDate: today })
  };
  await store.saveSeoSyncState(updatedState);
  logger.info?.('YouTube search analytics autopilot: updated ' + updatedCount + '/' +
    candidates.length + ' low-view-priority public videos for ' + windows.current.startDate +
    '–' + windows.current.endDate);
  return { state: updatedState, status: allFailed ? 'retry_scheduled' : 'complete',
    updatedCount, failedCount, windows };
}
module.exports = { runYoutubeSearchAutopilot, safeCursor };
