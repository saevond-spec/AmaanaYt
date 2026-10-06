'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateDuplicateMetadataTwoYears } = require('../scripts/simulate-duplicate-metadata-two-years');

test('two-year duplicate-metadata simulation blocks conflicting public edits and preserves visibility', () => {
  const simulation = simulateDuplicateMetadataTwoYears();
  const sweep = simulation.catalogSweep;

  assert.equal(simulation.horizon.days, 731);
  assert.equal(simulation.horizon.startDate, '2026-10-06');
  assert.ok(sweep.publicCandidates > 1000);
  assert.ok(sweep.duplicateCandidates > 0);
  assert.ok(sweep.nearDuplicateTitleConflicts > 0);
  assert.ok(sweep.duplicateDescriptionConflicts > 0);
  assert.equal(sweep.duplicateMetadataWriteAttempts, 0);
  assert.equal(sweep.noAutomaticEditForDuplicateMetadata, true);
  assert.equal(sweep.privacyInvariant, true);
  assert.ok(sweep.automaticMetadataWrites > 0);
  assert.ok(sweep.automaticThumbnailWrites > 0);
  assert.equal(simulation.catalogCoverageBoundary.catalogComplete, false);
  assert.equal(simulation.catalogCoverageBoundary.automaticMetadataWrites, 0);
  assert.equal(simulation.catalogCoverageBoundary.automaticThumbnailWrites, 0);
  assert.ok(simulation.dailyLimitStress.deferredToLaterRuns > 0);
  assert.equal(simulation.dailyLimitStress.limitInvariant, true);
  assert.equal(simulation.repeatedShortTitles.distinctInvariant, true);
  assert.equal(simulation.repeatedShortTitles.titlesWithFactualTimes, 11);
  assert.equal(simulation.rankingForecast.noPredictedPlacementOrViewLift, true);
});
