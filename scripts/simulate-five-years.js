'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : fallback;
}

function fraction(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function fiveYearDays(startDate) {
  const start = new Date(startDate + 'T00:00:00.000Z');
  if (!Number.isFinite(start.getTime())) throw new Error('SIM_START_DATE must be an ISO date');
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 5);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS) };
}

function simulateFiveYears(input = {}) {
  const startDate = input.startDate || process.env.SIM_START_DATE || new Date().toISOString().slice(0, 10);
  const window = fiveYearDays(startDate);
  const streamsPerDay = positiveInteger(input.streamsPerDay ?? process.env.SIM_STREAMS_PER_DAY, 1);
  const hoursPerStream = positiveInteger(input.hoursPerStream ?? process.env.SIM_HOURS_PER_STREAM, 6);
  const momentsPerStream = positiveInteger(input.momentsPerStream ?? process.env.SIM_MOMENTS_PER_STREAM, 3, 0);
  const publicVideos = positiveInteger(input.publicVideos ?? process.env.SIM_PUBLIC_VIDEO_COHORT, 1000, 0);
  const missingAnalysisShare = fraction(input.missingAnalysisShare ?? process.env.SIM_MISSING_ANALYSIS_SHARE, 0.30);
  const runsPerDay = positiveInteger(input.runsPerDay ?? process.env.SIM_SEO_RUNS_PER_DAY, 24);
  const analysisBatchSize = Math.min(50, positiveInteger(input.analysisBatchSize ?? process.env.SEO_ANALYSIS_BATCH_SIZE, 20));
  const analysisDailyLimit = positiveInteger(input.analysisDailyLimit ?? process.env.SEO_DAILY_LIMIT, 200);
  const seoWriteDailyLimit = positiveInteger(input.seoWriteDailyLimit ?? process.env.SEO_AUTO_DAILY_LIMIT, 50);
  const thumbnailBackfillDailyLimit = positiveInteger(input.thumbnailBackfillDailyLimit ?? process.env.SIM_THUMBNAIL_BACKFILL_PER_DAY, 50, 0);
  const defaultQuota = positiveInteger(input.defaultQuota ?? process.env.SIM_YOUTUBE_DAILY_QUOTA, 10000);
  const updateUnits = positiveInteger(input.updateUnits ?? process.env.SIM_VIDEO_UPDATE_UNITS, 50);
  const thumbnailUnits = positiveInteger(input.thumbnailUnits ?? process.env.SIM_THUMBNAIL_SET_UNITS, 50);
  const playlistAutoDailyLimit = positiveInteger(input.playlistAutoDailyLimit ?? process.env.YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT, 20);
  const playlistInsertUnits = positiveInteger(input.playlistInsertUnits ?? process.env.SIM_PLAYLIST_ITEM_INSERT_UNITS, 50);
  const playlistCheckUnits = positiveInteger(input.playlistCheckUnits ?? process.env.SIM_PLAYLIST_ITEM_CHECK_UNITS, 1);
  const playlistListMaxPages = positiveInteger(input.playlistListMaxPages ?? process.env.SIM_PLAYLIST_LIST_MAX_PAGES, 20);

  const streams = window.days * streamsPerDay;
  const missingAnalysisVideos = Math.ceil(publicVideos * missingAnalysisShare);
  const currentAnalysisPerDay = Math.min(analysisDailyLimit, runsPerDay);
  const batchedAnalysisPerDay = Math.min(analysisDailyLimit, analysisBatchSize * runsPerDay);
  const analysisQueueWaitDays = 6 / 24;
  const currentQueueDays = missingAnalysisVideos
    ? analysisQueueWaitDays + Math.ceil(missingAnalysisVideos / currentAnalysisPerDay) : 0;
  const batchedQueueDays = missingAnalysisVideos
    ? analysisQueueWaitDays + Math.ceil(missingAnalysisVideos / batchedAnalysisPerDay) : 0;
  const playlistAutoAssignmentsPerDay = playlistAutoDailyLimit * 2;
  const playlistAutoDailyUnits = playlistAutoAssignmentsPerDay *
    (playlistInsertUnits + playlistCheckUnits + playlistListMaxPages);
  const currentDailyUnits = seoWriteDailyLimit * updateUnits + streamsPerDay * thumbnailUnits + playlistAutoDailyUnits;
  const bulkThumbnailDailyUnits = thumbnailBackfillDailyLimit * thumbnailUnits;
  const totalWithBulkThumbnailBackfill = currentDailyUnits + bulkThumbnailDailyUnits;
  const candidateScanLimit = 20;
  const permanentForbiddenHead = candidateScanLimit;

  return {
    title: 'AmaanaYT five-year operational capacity simulation',
    note: 'Capacity and failure-mode simulation only; it does not forecast views, revenue, or ranking.',
    assumptions: { startDate: window.start, endDate: window.end, days: window.days, streamsPerDay,
      hoursPerStream, momentsPerStream, existingPublicVideoStressCohort: publicVideos,
      missingAnalysisShare, analysisBatchSize, analysisDailyLimit, seoWriteDailyLimit,
      playlistAutoDailyLimitPerPrivacy: playlistAutoDailyLimit },
    fiveYearPipeline: { streams, activeStreamHours: streams * hoursPerStream,
      privateLandscapeDrafts: streams, privateShortDrafts: streams * momentsPerStream,
      totalPrivateDrafts: streams * (1 + momentsPerStream),
      visibilityRule: 'All generated highlight and Short drafts stay private until owner approval.' },
    seoBackfill: { missingAnalysisVideos, currentQueueDays: Number(currentQueueDays.toFixed(2)),
      batchedQueueDays: Number(batchedQueueDays.toFixed(2)),
      bestCaseDaysToUpdatePublicCohortAtWriteLimit: Math.ceil(publicVideos / seoWriteDailyLimit),
      writeLimitMeaning: 'Best case assumes each public video has enough evidence; unsupported items remain skipped.' },
    failureScenario: { permanent403CandidatesAtHead: permanentForbiddenHead,
      scanWindowPerRun: candidateScanLimit, currentRepeatedAttemptsPerDay: permanentForbiddenHead * runsPerDay,
      afterFixCandidatesFreedOnNextScan: permanentForbiddenHead,
      behavior: 'Permanent permission/channel errors are skipped; quota and transient errors remain retryable.' },
    youtubeApiQuota: { defaultDailyUnits: defaultQuota, videoUpdateUnits: updateUnits,
      thumbnailSetUnits: thumbnailUnits, playlistItemInsertUnits: playlistInsertUnits,
      playlistItemCheckUnits: playlistCheckUnits, ownedPlaylistListMaxPages: playlistListMaxPages,
      maxPlaylistAssignmentsPerDay: playlistAutoAssignmentsPerDay,
      automaticPlaylistDailyUnits: playlistAutoDailyUnits, currentPipelineDailyQuotaUnits: currentDailyUnits,
      currentPipelineQuotaHeadroom: defaultQuota - currentDailyUnits,
      optionalExistingThumbnailBackfillUnitsPerDay: bulkThumbnailDailyUnits,
      combinedDailyQuotaUnitsWith50PerDayThumbnailBackfill: totalWithBulkThumbnailBackfill,
      headroomWithBulkThumbnailBackfillBeforeReads: defaultQuota - totalWithBulkThumbnailBackfill }
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(simulateFiveYears(), null, 2) + '\n');
}

module.exports = { simulateFiveYears };
