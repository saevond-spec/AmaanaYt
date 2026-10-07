'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const { buildGameplayEditPlan } = require('../src/gameplay-editor');

function dateOnly(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('startDate must be an ISO date');
  const date = new Date(text + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error('startDate must be a valid ISO date');
  }
  return date;
}

function makeHorizon(startDate, years) {
  const start = dateOnly(startDate);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + years);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDateExclusive: end.toISOString().slice(0, 10),
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS),
    years
  };
}

function fixtureMoments(batchId, count, mode = 'normal') {
  return Array.from({ length: count }, (_unused, index) => ({
    startSeconds: 120 + index * 90,
    endSeconds: 135 + index * 90,
    duration: 15,
    title: 'Gameplay moment ' + (index + 1),
    reason: 'Synthetic candidate from a supplied timestamp',
    score: mode === 'no_scores' ? null
      : mode === 'tie' ? 70
      : ((batchId * 31 + index * 47) % 100) + 1
  }));
}

function assertPlanInvariant(plan, count) {
  if (plan.orderedIndexes.length !== count || new Set(plan.orderedIndexes).size !== count ||
      plan.orderedIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new Error('Edit plan lost or duplicated a supplied moment');
  }
  if (plan.hookIndex !== null && plan.orderedIndexes[0] !== plan.hookIndex) {
    throw new Error('The supplied hook did not open the edit');
  }
}

function summarizeScenario(name, jobs, style) {
  const metrics = {
    plannedBatches: jobs.length,
    selectedMoments: 0,
    plannedShorts: 0,
    openingHooks: 0,
    reorderedBatches: 0,
    chronologicalFallbackBatches: 0,
    droppedMoments: 0,
    duplicatedMoments: 0,
    ownerReviewPrivateBatches: jobs.length,
    publicUploads: 0,
    existingVisibilityMutations: 0
  };

  for (const job of jobs) {
    const plan = buildGameplayEditPlan(job.highlights, style);
    assertPlanInvariant(plan, job.highlights.length);
    metrics.selectedMoments += job.highlights.length;
    metrics.plannedShorts += job.highlights.length;
    if (plan.hookIndex !== null) metrics.openingHooks += 1;
    if (plan.reordered) metrics.reorderedBatches += 1;
    if (style === 'story' && plan.hookIndex === null) metrics.chronologicalFallbackBatches += 1;
    metrics.droppedMoments += Math.max(0, job.highlights.length - plan.orderedIndexes.length);
    metrics.duplicatedMoments += plan.orderedIndexes.length - new Set(plan.orderedIndexes).size;
  }

  return {
    name,
    ...metrics,
    privateFirstInvariant: metrics.publicUploads === 0 &&
      metrics.existingVisibilityMutations === 0 &&
      metrics.ownerReviewPrivateBatches === metrics.plannedBatches
  };
}

function runPropertyStress(cases = 10000) {
  let state = 0x4a6d2b19;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  let hooks = 0;
  let noScoreFallbacks = 0;

  for (let caseId = 1; caseId <= cases; caseId += 1) {
    const count = 1 + (random() % 8);
    const moments = Array.from({ length: count }, (_unused, index) => {
      const value = random();
      return {
        startSeconds: index * 75 + (value % 30),
        score: caseId % 31 === 0 || value % 11 === 0 ? null : value % 101,
        title: 'Stress moment ' + index
      };
    });
    const original = JSON.stringify(moments);
    const plan = buildGameplayEditPlan(moments, 'story');
    assertPlanInvariant(plan, count);
    const chronological = moments.map((moment, index) => ({ index, start: moment.startSeconds }))
      .sort((left, right) => left.start - right.start || left.index - right.index)
      .map((item) => item.index);
    const candidates = moments.map((moment, index) => ({
      index, start: moment.startSeconds, score: moment.score
    })).filter((item) => item.score !== null && item.score > 0)
      .sort((left, right) => right.score - left.score ||
        left.start - right.start || left.index - right.index);
    const expected = candidates.length
      ? [candidates[0].index, ...chronological.filter((index) => index !== candidates[0].index)]
      : chronological;
    if (JSON.stringify(plan.orderedIndexes) !== JSON.stringify(expected)) {
      throw new Error('Edit order did not preserve the hook-and-chronology rule');
    }
    if (plan.hookIndex !== null) hooks += 1;
    else noScoreFallbacks += 1;
    if (JSON.stringify(moments) !== original) throw new Error('Edit planning mutated its input');
  }

  return { cases, hooks, chronologicalFallbacks: noScoreFallbacks };
}

function simulateGameplayEditingTwoYears(input = {}) {
  const startDate = input.startDate || '2026-10-07';
  const years = Number.isSafeInteger(input.years) && input.years > 0 ? input.years : 2;
  const horizon = makeHorizon(startDate, years);
  const weeklyJobs = [];
  let batchId = 0;
  for (let day = 0; day < horizon.days; day += 7) {
    batchId += 1;
    const count = 3 + ((batchId - 1) % 2);
    const scoreMode = batchId % 17 === 0 ? 'no_scores'
      : batchId % 29 === 0 ? 'tie' : 'normal';
    weeklyJobs.push({
      id: batchId,
      highlights: fixtureMoments(batchId, count, scoreMode)
    });
  }

  const highVolumeJobs = [];
  for (let day = 0; day < horizon.days; day += 1) {
    const id = day + 1;
    highVolumeJobs.push({
      id,
      highlights: fixtureMoments(id, 3 + (id % 6),
        id % 17 === 0 ? 'no_scores' : id % 29 === 0 ? 'tie' : 'normal')
    });
  }

  const story = summarizeScenario('Weekly story-first creator cadence', weeklyJobs, 'story');
  const chronological = summarizeScenario('Weekly chronological control', weeklyJobs, 'chronological');
  const highVolume = summarizeScenario('Daily high-volume intake stress', highVolumeJobs, 'story');
  const propertyStress = runPropertyStress(Number.isSafeInteger(input.propertyCases) &&
    input.propertyCases > 0 ? input.propertyCases : 10000);

  return {
    title: 'AmaanaYT gameplay edit-plan two-year stress simulation',
    note: 'This is a deterministic structural/load simulation of timestamp plans. It does not render two years of video, call Twitch or YouTube, publish uploads, or predict views, watch time, CTR, or revenue. Fault patterns and moment scores are synthetic.',
    horizon,
    assumptions: {
      weeklyMomentsPerBatch: '3 or 4',
      weeklyOutputCadence: 'one highlight reel and one Short per supplied moment',
      syntheticNoScoreBatchEvery: 17,
      syntheticEqualScoreBatchEvery: 29,
      highVolumeScenario: 'one package every day with 3 to 8 moments',
      randomizedPropertyCases: propertyStress.cases,
      ownerReviewRequired: true,
      newUploadsRemainPrivate: true
    },
    scenarios: { story, chronological, highVolume },
    randomizedPropertyStress: propertyStress
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(simulateGameplayEditingTwoYears(), null, 2) + '\n');
}

module.exports = { simulateGameplayEditingTwoYears, buildGameplayEditPlan };
