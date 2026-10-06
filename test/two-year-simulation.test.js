'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateTwoYears } = require('../scripts/simulate-two-years');

test('two-year planned cadence checks every output and leaves the bundle private for review', () => {
  const result = simulateTwoYears({ startDate: '2026-10-06' });
  assert.equal(result.horizon.days, 731);
  assert.equal(result.horizon.endDateExclusive, '2028-10-06');
  const planned = result.scenarios.plannedCadence.outcome;
  assert.equal(planned.plannedBatches, 105);
  assert.equal(planned.plannedHighlights, 105);
  assert.equal(planned.plannedShorts, 367);
  assert.equal(planned.plannedPrivateUploads, 472);
  assert.equal(planned.finishedPrivateUploads, 472);
  assert.equal(planned.completedBatches, 105);
  assert.equal(planned.batchesNeedingManualRecovery, 0);
  assert.equal(planned.publicUploads, 0);
  assert.equal(planned.visibilityMutations, 0);
  assert.equal(planned.ownerApprovalRequired, true);
  assert.equal(planned.privacyInvariant, true);
});

test('six-day streaming cadence exposes the owner-review volume if every VOD is ingested', () => {
  const result = simulateTwoYears({ startDate: '2026-10-06' });
  const ingest = result.scenarios.fullStreamIngest.outcome;
  assert.equal(ingest.plannedBatches, 601);
  assert.equal(ingest.plannedHighlights, 601);
  assert.equal(ingest.plannedShorts, 1803);
  assert.equal(ingest.plannedPrivateUploads, 2404);
  assert.equal(ingest.finishedPrivateUploads, 2404);
  assert.equal(ingest.reviewQueueBeyondWeeklyPlan, 1932);
  assert.equal(ingest.publicUploads, 0);
  assert.equal(ingest.privacyInvariant, true);
});

test('processing waits retry, unknown status does not count as finished, and failed output blocks bundle completion', () => {
  const result = simulateTwoYears({ startDate: '2026-10-06' });
  const stress = result.scenarios.recoveryStress.outcome;
  assert.equal(stress.plannedBatches, 105);
  assert.equal(stress.processingPendingChecks, 6);
  assert.equal(stress.unknownProcessingStateChecks, 2);
  assert.equal(stress.transientApiFailures, 4);
  assert.equal(stress.terminalProcessingFailures, 1);
  assert.equal(stress.completedBatches, 104);
  assert.equal(stress.readyForOwnerReviewUploads, 468);
  assert.equal(stress.batchesNeedingManualRecovery, 1);
  assert.ok(stress.automaticRetries >= 12);
  assert.equal(stress.publicUploads, 0);
  assert.equal(stress.privacyInvariant, true);
});

test('current market data annotates topic windows without inventing performance uplift', () => {
  const result = simulateTwoYears({ startDate: '2026-10-06' });
  assert.equal(result.currentMarketResearch.asOf, '2026-10-06');
  assert.equal(result.currentMarketResearch.publisherReportedArcRaidersAudienceSignals.reportedInterestInDedicatedPvePercent, 51);
  assert.equal(result.currentMarketResearch.youtubeGuidance.noPredictedViewLift, true);
  assert.equal(result.currentMarketResearch.marketWindowCoverageFromPlannedCadence[0].candidatePackagesInWindow, 1);
  assert.equal(result.currentMarketResearch.marketWindowCoverageFromPlannedCadence[1].candidatePackagesInWindow, 1);
  assert.deepEqual(result.lowViewPriorityPreview.priorityOrder, [
    'sample-12-views', 'sample-84-views', 'sample-1400-views', 'sample-unknown-views'
  ]);
});
