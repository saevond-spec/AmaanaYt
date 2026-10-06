const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateFiveYears } = require('../scripts/simulate-five-years');

test('five-year simulation reports draft volume, queue throughput, and quota headroom', () => {
  const result = simulateFiveYears({ startDate: '2026-10-02', streamsPerDay: 1, hoursPerStream: 6,
    momentsPerStream: 3, publicVideos: 1000, missingAnalysisShare: 0.30, runsPerDay: 24,
    analysisBatchSize: 20, analysisDailyLimit: 200, seoWriteDailyLimit: 50,
    thumbnailBackfillDailyLimit: 50, defaultQuota: 10000, updateUnits: 50, thumbnailUnits: 50 });
  assert.equal(result.assumptions.days, 1826);
  assert.equal(result.fiveYearPipeline.privateLandscapeDrafts, 1826);
  assert.equal(result.fiveYearPipeline.privateShortDrafts, 5478);
  assert.equal(result.fiveYearPipeline.totalPrivateDrafts, 7304);
  assert.equal(result.seoBackfill.missingAnalysisVideos, 300);
  assert.equal(result.seoBackfill.currentQueueDays, 13.25);
  assert.equal(result.seoBackfill.batchedQueueDays, 2.25);
  assert.equal(result.seoBackfill.bestCaseDaysToUpdatePublicCohortAtWriteLimit, 20);
  assert.equal(result.failureScenario.currentRepeatedAttemptsPerDay, 480);
  assert.equal(result.youtubeApiQuota.maxPlaylistAssignmentsPerDay, 60);
  assert.equal(result.youtubeApiQuota.ownedPlaylistListMaxPages, 20);
  assert.equal(result.youtubeApiQuota.automaticPlaylistDailyUnits, 3262);
  assert.equal(result.youtubeApiQuota.videoInsertCallsPerDay, 4);
  assert.equal(result.youtubeApiQuota.videoInsertQuotaFits, true);
  assert.equal(result.youtubeApiQuota.marketSearchCallsPerDay, 3);
  assert.equal(result.youtubeApiQuota.marketSearchQuotaFits, true);
  assert.equal(result.youtubeApiQuota.publicationDailyQuotaUnits, 204);
  assert.equal(result.youtubeApiQuota.currentPipelineDailyQuotaUnits, 6016);
  assert.equal(result.youtubeApiQuota.combinedDailyQuotaUnitsWith50PerDayThumbnailBackfill, 8516);
  assert.equal(result.youtubeApiQuota.headroomWithBulkThumbnailBackfillBeforeReads, 1484);
});

test('five-year lifecycle simulation exercises baseline and deterministic recovery stress', () => {
  const result = simulateFiveYears({ startDate: '2026-10-02', streamsPerDay: 1, momentsPerStream: 3,
    productionAttemptsPerDay: 4, productionMaxAttempts: 8 });
  const reliability = result.productionReliability;
  const baseline = reliability.baseline;
  const stress = reliability.recoveryStress;

  assert.equal(reliability.assumptions.modelDays, 1826);
  assert.match(reliability.assumptions.timestampSource, /SweatyClanker/);
  assert.match(reliability.assumptions.stressSchedule, /not measured production failure rates/);
  assert.equal(baseline.submittedBatches, 1826);
  assert.equal(baseline.completedBatches, 1826);
  assert.equal(baseline.privateVideosProduced, 7304);
  assert.equal(baseline.generatedPublicVideos, 7304);
  assert.equal(baseline.prematurePublicVideos, 0);
  assert.equal(baseline.automaticRetries, 0);
  assert.equal(baseline.visibilityInvariant, true);
  assert.equal(stress.submittedBatches, 1826);
  assert.equal(stress.completedBatches, 1824);
  assert.equal(stress.batchesNeedingManualRecovery, 2);
  assert.equal(stress.queuedAtHorizon, 0);
  assert.equal(stress.duplicateWebhookDeliveries, 260);
  assert.ok(stress.automaticRetries > 0);
  assert.ok(stress.simulatedProcessRestarts > 0);
  assert.ok(stress.transientFailures.youtubePublish429 > 0);
  assert.equal(stress.publicationAttempts >= stress.generatedPublicVideos, true);
  assert.equal(stress.duplicateParentUploads, 0);
  assert.equal(stress.generatedPublicVideos, 7297);
  assert.equal(stress.prematurePublicVideos, 0);
  assert.equal(stress.permanentPublicationFailures, 1);
  assert.equal(stress.existingVisibilityMutations, 0);
  assert.equal(stress.visibilityInvariant, true);
  assert.equal(stress.parentPrivateUploads, 1825);
  assert.equal(stress.shortPrivateUploads, 5475);
});
