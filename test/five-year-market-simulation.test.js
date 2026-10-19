'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRecentGameVideoSearchQueries } = require('../src/youtube');
const { median, summarizeMarketSamples } = require('../src/seo-market');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_YEARS_DAYS = 1826;

function deterministicJitter(day, index) {
  const value = (day * 48271 + index * 69621 + 104729) % 2147483647;
  const unit = value / 2147483647;
  return 0.55 + unit * 0.9;
}

function buildScenarioSamples(day, now) {
  const year = Math.min(4, Math.floor(day / 365));
  const demandLevel = [32, 22, 11, 46, 17][year];
  const seasonal = 1 + 0.28 * Math.sin((2 * Math.PI * day) / 365);
  const rows = [];

  // Model a full seven-day result window with 25 uploads per day. Counts are
  // overdispersed by creator-level velocity differences, with occasional viral hits.
  for (let index = 0; index < 175; index += 1) {
    const ageDays = Math.floor(index / 25) + 0.25 + ((index % 25) / 25) * 0.7;
    const isViralOutlier = index === 174 && day % 47 === 0;
    const velocity = demandLevel * seasonal * deterministicJitter(day, index) *
      (isViralOutlier ? 18 : 1);
    rows.push({
      id: `sim-${day}-${index}`,
      title: `ARC Raiders extraction challenge phase-${year}`,
      publishedAt: new Date(now - ageDays * DAY_MS).toISOString(),
      viewCount: Math.round(velocity * ageDays),
      velocity
    });
  }
  return rows;
}

test('five-year market scenarios stay current and bounded through launches, declines, seasonality, and viral outliers', () => {
  const start = Date.parse('2026-10-19T12:00:00.000Z');
  let sampledMedianError = 0;
  let topOnlyMedianError = 0;
  let searchCalls = 0;
  let daysWithViralOutlier = 0;
  const annualSummaries = Array.from({ length: 5 }, () => ({
    observations: 0, averageConfidence: 0, maximumConfidence: 0
  }));

  for (let day = 0; day < FIVE_YEARS_DAYS; day += 1) {
    const now = start + day * DAY_MS;
    const queries = buildRecentGameVideoSearchQueries('ARC Raiders', { now });
    assert.deepEqual(queries.map((query) => query.order), ['date', 'viewCount']);
    assert.ok(queries.every((query) => Date.parse(query.publishedAfter) === now - 7 * DAY_MS));
    searchCalls += queries.length;

    const rows = buildScenarioSamples(day, now);
    const newest = [...rows].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 25);
    const highestViewCount = [...rows].sort((a, b) => b.viewCount - a.viewCount).slice(0, 25);
    const combined = new Map([...newest, ...highestViewCount].map((row) => [row.id, row]));
    const mixedSummary = summarizeMarketSamples([...combined.values()], { now, game: 'ARC Raiders' });
    const topOnlySummary = summarizeMarketSamples(highestViewCount, { now, game: 'ARC Raiders' });
    const truth = median(rows.map((row) => row.velocity));
    const mixedEstimate = mixedSummary.metrics.medianViewsPerDay;
    const topOnlyEstimate = topOnlySummary.metrics.medianViewsPerDay;
    sampledMedianError += Math.abs(mixedEstimate - truth) / Math.max(1, truth);
    topOnlyMedianError += Math.abs(topOnlyEstimate - truth) / Math.max(1, truth);
    if (day % 47 === 0) daysWithViralOutlier += 1;

    assert.equal(mixedSummary.metrics.sampleCount, combined.size);
    assert.ok(combined.size >= 25 && combined.size <= 50);
    assert.ok(Number.isFinite(mixedEstimate) && mixedEstimate >= 0);
    assert.ok(mixedSummary.metrics.confidence >= 0 && mixedSummary.metrics.confidence <= 1);
    assert.ok(mixedSummary.terms.length <= 8);
    assert.ok(mixedSummary.samples.length <= 5);

    const annual = annualSummaries[Math.min(4, Math.floor(day / 365))];
    annual.observations += 1;
    annual.averageConfidence += mixedSummary.metrics.confidence;
    annual.maximumConfidence = Math.max(annual.maximumConfidence, mixedSummary.metrics.confidence);
  }

  for (const annual of annualSummaries) {
    annual.averageConfidence /= annual.observations;
    assert.equal(annual.observations >= 365, true);
    assert.ok(annual.averageConfidence >= 0 && annual.averageConfidence <= 1);
    assert.ok(annual.maximumConfidence <= 1);
  }

  assert.equal(searchCalls, FIVE_YEARS_DAYS * 2);
  assert.ok(daysWithViralOutlier > 30);
  // Combining a fresh cohort with top performers reduces the systematic upward
  // bias versus using view-count-ranked results alone in this stress fixture.
  assert.ok(sampledMedianError < topOnlyMedianError);
});
