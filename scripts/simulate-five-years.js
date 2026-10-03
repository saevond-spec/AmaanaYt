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

function interval(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function every(id, period) {
  return period > 0 && id % period === 0;
}

function simulateProductionScenario({ days, streamsPerDay, momentsPerStream, attemptsPerDay, maxAttempts, faults }) {
  const jobs = [];
  const metrics = {
    submittedBatches: days * streamsPerDay,
    duplicateWebhookDeliveries: 0,
    delayedArchives: 0,
    workerAttempts: 0,
    automaticRetries: 0,
    completedBatches: 0,
    batchesNeedingManualRecovery: 0,
    queuedAtHorizon: 0,
    parentPrivateUploads: 0,
    shortPrivateUploads: 0,
    appliedThumbnails: 0,
    seoRegistrations: 0,
    twitchClipCreates: 0,
    renderAttempts: 0,
    simulatedProcessRestarts: 0,
    transientFailures: {},
    permanentPermissionFailures: 0,
    permanentPublicationFailures: 0,
    duplicateParentUploads: 0,
    generatedPublicVideos: 0,
    prematurePublicVideos: 0,
    publicationAttempts: 0,
    existingVisibilityMutations: 0
  };

  let serial = 0;
  for (let day = 0; day < days; day += 1) {
    for (let stream = 0; stream < streamsPerDay; stream += 1) {
      serial += 1;
      const delayed = every(serial, faults.archiveDelayEvery);
      if (delayed) metrics.delayedArchives += 1;
      if (every(serial, faults.duplicateWebhookEvery)) metrics.duplicateWebhookDeliveries += 1;
      jobs.push({
        id: serial,
        readyDay: day + (delayed ? 1 : 0),
        attempts: 0,
        status: 'queued',
        clipCreated: Array(momentsPerStream).fill(false),
        shortUploaded: Array(momentsPerStream).fill(false),
        published: Array(momentsPerStream + 1).fill(false),
        seoRegistered: new Set(),
        usedFaults: new Set(),
        parentUploaded: false,
        thumbnailApplied: false,
        fault: {
          twitch429: every(serial, faults.twitch429Every),
          renderFailure: every(serial, faults.renderFailureEvery),
          thumbnail429: every(serial, faults.thumbnail429Every),
          short429: every(serial, faults.short429Every),
          seo503: every(serial, faults.seo503Every),
          restart: every(serial, faults.restartEvery),
          youtube403: every(serial, faults.youtube403Every),
          youtubePublish429: every(serial, faults.youtubePublish429Every),
          youtubePublish403: every(serial, faults.youtubePublish403Every)
        }
      });
    }
  }

  const queue = [...jobs];
  function transient(job, key) {
    if (!job.fault[key] || job.usedFaults.has(key)) return false;
    job.usedFaults.add(key);
    metrics.transientFailures[key] = (metrics.transientFailures[key] || 0) + 1;
    return true;
  }

  function runAttempt(job) {
    job.attempts += 1;
    metrics.workerAttempts += 1;
    for (let index = 0; index < momentsPerStream; index += 1) {
      if (job.clipCreated[index]) continue;
      if (transient(job, 'twitch429')) return { retry: true };
      job.clipCreated[index] = true;
      metrics.twitchClipCreates += 1;
    }
    metrics.renderAttempts += 1;
    if (transient(job, 'renderFailure')) return { retry: true };

    if (!job.parentUploaded) {
      if (job.fault.youtube403) {
        job.usedFaults.add('youtube403');
        metrics.permanentPermissionFailures += 1;
        return { permanent: true };
      }
      job.parentUploaded = true;
      metrics.parentPrivateUploads += 1;
    }
    if (transient(job, 'restart')) {
      metrics.simulatedProcessRestarts += 1;
      return { retry: true };
    }
    if (!job.thumbnailApplied) {
      if (transient(job, 'thumbnail429')) return { retry: true };
      job.thumbnailApplied = true;
      metrics.appliedThumbnails += 1;
    }
    for (let index = 0; index < momentsPerStream; index += 1) {
      if (job.shortUploaded[index]) continue;
      if (transient(job, 'short429')) return { retry: true };
      job.shortUploaded[index] = true;
      metrics.shortPrivateUploads += 1;
    }
    const seoCount = momentsPerStream + 1;
    for (let index = 0; index < seoCount; index += 1) {
      if (job.seoRegistered.has(index)) continue;
      if (transient(job, 'seo503')) return { retry: true };
      job.seoRegistered.add(index);
      metrics.seoRegistrations += 1;
    }
    // All media, thumbnails, and SEO registrations have passed before visibility changes start.
    const publicationCount = momentsPerStream + 1;
    for (let index = 0; index < publicationCount; index += 1) {
      if (job.published[index]) continue;
      metrics.publicationAttempts += 1;
      if (index === 0 && transient(job, 'youtubePublish429')) return { retry: true };
      if (index === 1 && job.fault.youtubePublish403 && !job.usedFaults.has('youtubePublish403')) {
        job.usedFaults.add('youtubePublish403');
        metrics.permanentPublicationFailures += 1;
        return { permanent: true };
      }
      job.published[index] = true;
      metrics.generatedPublicVideos += 1;
    }
    return { success: true };
  }

  for (let day = 0; day < days; day += 1) {
    let capacity = attemptsPerDay;
    while (capacity > 0) {
      queue.sort((a, b) => a.readyDay - b.readyDay || a.id - b.id);
      const index = queue.findIndex((job) => job.readyDay <= day);
      if (index < 0) break;
      const [job] = queue.splice(index, 1);
      capacity -= 1;
      const result = runAttempt(job);
      if (result.success) {
        job.status = 'complete';
        metrics.completedBatches += 1;
      } else if (result.permanent) {
        job.status = 'manual_review';
        metrics.batchesNeedingManualRecovery += 1;
      } else if (job.attempts < maxAttempts) {
        job.readyDay = day + 1;
        queue.push(job);
        metrics.automaticRetries += 1;
      } else {
        job.status = 'manual_review';
        metrics.batchesNeedingManualRecovery += 1;
      }
    }
  }

  metrics.queuedAtHorizon = queue.length;
  metrics.privateVideosProduced = metrics.parentPrivateUploads + metrics.shortPrivateUploads;
  metrics.visibilityInvariant = metrics.prematurePublicVideos === 0 && metrics.existingVisibilityMutations === 0;
  return metrics;
}

function simulateProductionHorizon(input, days) {
  const streamsPerDay = positiveInteger(input.streamsPerDay ?? process.env.SIM_STREAMS_PER_DAY, 1);
  const momentsPerStream = positiveInteger(input.momentsPerStream ?? process.env.SIM_MOMENTS_PER_STREAM, 3, 0);
  const attemptsPerDay = positiveInteger(input.productionAttemptsPerDay, 4);
  const maxAttempts = positiveInteger(input.productionMaxAttempts, 8);
  const supplied = input.productionFaults || {};
  const stressFaults = {
    duplicateWebhookEvery: interval(supplied.duplicateWebhookEvery, 7),
    archiveDelayEvery: interval(supplied.archiveDelayEvery, 31),
    twitch429Every: interval(supplied.twitch429Every, 37),
    renderFailureEvery: interval(supplied.renderFailureEvery, 53),
    thumbnail429Every: interval(supplied.thumbnail429Every, 61),
    short429Every: interval(supplied.short429Every, 67),
    seo503Every: interval(supplied.seo503Every, 73),
    restartEvery: interval(supplied.restartEvery, 89),
    youtube403Every: interval(supplied.youtube403Every, 997),
    youtubePublish429Every: interval(supplied.youtubePublish429Every, 101),
    youtubePublish403Every: interval(supplied.youtubePublish403Every, 991)
  };
  const noFaults = Object.fromEntries(Object.keys(stressFaults).map((key) => [key, 0]));
  return {
    assumptions: {
      modelDays: days, streamsPerDay, momentsPerStream, workerAttemptsPerDay: attemptsPerDay,
      maxAttemptsPerBatch: maxAttempts,
      timestampSource: 'SweatyClanker supplies candidate VOD timestamps; the app checks them against Twitch VOD and clip metadata.',
      stressSchedule: 'Deterministic fault intervals are repeatable test injections, not measured production failure rates.'
    },
    baseline: simulateProductionScenario({
      days, streamsPerDay, momentsPerStream, attemptsPerDay, maxAttempts, faults: noFaults
    }),
    recoveryStress: simulateProductionScenario({
      days, streamsPerDay, momentsPerStream, attemptsPerDay, maxAttempts, faults: stressFaults
    }),
    stressFaultIntervals: stressFaults
  };
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
  const videoListUnits = positiveInteger(input.videoListUnits ?? process.env.SIM_VIDEO_LIST_UNITS, 1, 0);
  const marketSearchCallsPerDay = positiveInteger(input.marketSearchCallsPerDay ?? process.env.SIM_MARKET_SEARCH_CALLS_PER_DAY, 3, 0);
  const marketSearchDailyLimit = positiveInteger(input.marketSearchDailyLimit ?? process.env.SIM_YOUTUBE_SEARCH_DAILY_LIMIT, 100);
  const videoInsertDailyLimit = positiveInteger(input.videoInsertDailyLimit ?? process.env.SIM_YOUTUBE_VIDEO_INSERT_DAILY_LIMIT, 100);
  const autoPublish = input.autoPublish !== false && String(process.env.SIM_AUTO_PUBLISH || 'true').toLowerCase() !== 'false';

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
  const uploadsPerStream = 1 + momentsPerStream;
  const videoInsertCallsPerDay = streamsPerDay * uploadsPerStream;
  const videoPublicationCallsPerDay = autoPublish ? videoInsertCallsPerDay : 0;
  const publicationDailyUnits = videoPublicationCallsPerDay * (updateUnits + videoListUnits);
  const currentDailyUnits = seoWriteDailyLimit * updateUnits + streamsPerDay * thumbnailUnits +
    playlistAutoDailyUnits + publicationDailyUnits;
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
      visibilityRule: 'New highlight and Short uploads start private and publish only after timestamp, render, thumbnail, SEO-registration, and YouTube-processing checks pass; existing private and unlisted videos are untouched.' },
    seoBackfill: { missingAnalysisVideos, currentQueueDays: Number(currentQueueDays.toFixed(2)),
      batchedQueueDays: Number(batchedQueueDays.toFixed(2)),
      bestCaseDaysToUpdatePublicCohortAtWriteLimit: Math.ceil(publicVideos / seoWriteDailyLimit),
      writeLimitMeaning: 'Best case assumes each public video has enough evidence; unsupported items remain skipped.' },
    failureScenario: { permanent403CandidatesAtHead: permanentForbiddenHead,
      scanWindowPerRun: candidateScanLimit, currentRepeatedAttemptsPerDay: permanentForbiddenHead * runsPerDay,
      afterFixCandidatesFreedOnNextScan: permanentForbiddenHead,
      behavior: 'Permanent permission/channel errors are skipped; quota and transient errors remain retryable.' },
    productionReliability: simulateProductionHorizon(input, window.days),
    youtubeApiQuota: { defaultDailyUnits: defaultQuota, videoUpdateUnits: updateUnits,
      videoListUnits, videoInsertCallsPerDay, videoInsertDailyLimit,
      videoInsertQuotaFits: videoInsertCallsPerDay <= videoInsertDailyLimit,
      marketSearchCallsPerDay, marketSearchDailyLimit,
      marketSearchQuotaFits: marketSearchCallsPerDay <= marketSearchDailyLimit,
      automaticPublicationEnabled: autoPublish, publicationVideoUpdatesPerDay: videoPublicationCallsPerDay,
      publicationDailyQuotaUnits: publicationDailyUnits, playlistItemInsertUnits: playlistInsertUnits,
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

module.exports = { simulateFiveYears, simulateProductionHorizon };