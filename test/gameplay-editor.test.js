'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGameplayEditPlan } = require('../src/gameplay-editor');
const { simulateGameplayEditingTwoYears } = require('../scripts/simulate-gameplay-editing-two-years');

const moments = [
  { startSeconds: 10, endSeconds: 25, score: 82, title: 'First by time' },
  { startSeconds: 80, endSeconds: 95, score: 95, title: 'Best supplied score' },
  { startSeconds: 45, endSeconds: 60, score: 91, title: 'Second by time' }
];

test('story edit opens on the highest scored supplied moment and keeps every other moment chronological', () => {
  const plan = buildGameplayEditPlan(moments, 'story');
  assert.equal(plan.hookIndex, 1);
  assert.equal(plan.hookTitle, 'Best supplied score');
  assert.deepEqual(plan.orderedIndexes, [1, 0, 2]);
  assert.equal(plan.preservesAllMoments, true);
  assert.equal(plan.reordered, true);
  assert.deepEqual(moments.map((moment) => moment.title),
    ['First by time', 'Best supplied score', 'Second by time']);
});

test('chronological edit preserves source order after timestamp sorting and adds no hook', () => {
  const plan = buildGameplayEditPlan(moments, 'chronological');
  assert.equal(plan.hookIndex, null);
  assert.deepEqual(plan.orderedIndexes, [0, 2, 1]);
  assert.equal(plan.reordered, true);
});

test('score ties use the earliest source timestamp and no scores fall back to chronology', () => {
  const tie = moments.map((moment) => ({ ...moment, score: 77 }));
  assert.equal(buildGameplayEditPlan(tie).hookIndex, 0);
  const unscored = moments.map((moment) => ({ ...moment, score: null }));
  const fallback = buildGameplayEditPlan(unscored, 'story');
  assert.equal(fallback.hookIndex, null);
  assert.deepEqual(fallback.orderedIndexes, [0, 2, 1]);
  const zeroScores = moments.map((moment) => ({ ...moment, score: 0 }));
  assert.equal(buildGameplayEditPlan(zeroScores).hookIndex, null);
});

test('edit planner rejects unsupported styles, missing timings, and invalid scores', () => {
  assert.throws(() => buildGameplayEditPlan([], 'story'), /between one and eight/);
  assert.throws(() => buildGameplayEditPlan(moments, 'hype'), /editingStyle/);
  assert.throws(() => buildGameplayEditPlan([{ score: 50 }]), /start time/);
  assert.throws(() => buildGameplayEditPlan([{ startSeconds: 0, score: 101 }]), /score/);
  assert.throws(() => buildGameplayEditPlan(Array.from({ length: 9 }, (_v, index) =>
    ({ startSeconds: index, score: 1 }))), /between one and eight/);
});

test('two calendar years retain every supplied moment and keep every bundle private', () => {
  const result = simulateGameplayEditingTwoYears({
    startDate: '2026-10-07', years: 2, propertyCases: 10000
  });
  assert.equal(result.horizon.days, 731);
  assert.equal(result.horizon.endDateExclusive, '2028-10-07');
  assert.equal(result.scenarios.story.plannedBatches, 105);
  assert.equal(result.scenarios.story.selectedMoments, 367);
  assert.equal(result.scenarios.story.plannedShorts, 367);
  assert.equal(result.scenarios.story.droppedMoments, 0);
  assert.equal(result.scenarios.story.duplicatedMoments, 0);
  assert.equal(result.scenarios.story.publicUploads, 0);
  assert.equal(result.scenarios.story.privateFirstInvariant, true);
  assert.equal(result.scenarios.chronological.reorderedBatches, 0);
  assert.equal(result.scenarios.highVolume.plannedBatches, 731);
  assert.equal(result.scenarios.highVolume.droppedMoments, 0);
  assert.equal(result.scenarios.highVolume.duplicatedMoments, 0);
  assert.equal(result.randomizedPropertyStress.cases, 10000);
  assert.equal(result.randomizedPropertyStress.hooks +
    result.randomizedPropertyStress.chronologicalFallbacks, 10000);
});
