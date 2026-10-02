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
  assert.equal(result.youtubeApiQuota.currentPipelineDailyWriteUnits, 2550);
  assert.equal(result.youtubeApiQuota.combinedDailyWriteUnitsWith50PerDayThumbnailBackfill, 5050);
  assert.equal(result.youtubeApiQuota.headroomWithBulkThumbnailBackfillBeforeReads, 4950);
});
