'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIVE_TARGET_SECONDS, LIVE_SHORT_COUNT, buildLiveHighlightAgentPlan } =
  require('../src/live-highlight-agents');

function sample(duration = 900, count = 15) {
  const highlights = Array.from({ length: count }, (_, index) => ({
    duration: duration / count, startSeconds: index * 100
  }));
  const evidence = highlights.map((_moment, index) => ({ clipId: String(index), selectionScore: index }));
  const candidateById = new Map(evidence.map(({ clipId }) => [
    clipId, { clip: { visualGameplayVerification: { verified: true } } }
  ]));
  return { selection: { highlights, evidence }, candidateById, streamId: '42', batchIndex: 1 };
}

test('live agents plan exactly 15 minutes and three distinct ranked Shorts', () => {
  const plan = buildLiveHighlightAgentPlan(sample());
  assert.equal(LIVE_TARGET_SECONDS, 900);
  assert.equal(LIVE_SHORT_COUNT, 3);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.shortCandidateIndexes, [14, 13, 12]);
  assert.equal(plan.agentPlan.specialists.length, 6);
  assert.equal(plan.agentPlan.specialists.at(-1).result, 'gated_by_existing_publication_policy');
});

test('insufficient verified gameplay is held, not padded', () => {
  const plan = buildLiveHighlightAgentPlan(sample(720));
  assert.equal(plan.ready, false);
  assert.equal(plan.reason, 'insufficient_verified_gameplay');
});

test('unverified video cannot enter publishing workflow', () => {
  const input = sample();
  input.candidateById.get('1').clip.visualGameplayVerification.verified = false;
  const plan = buildLiveHighlightAgentPlan(input);
  assert.equal(plan.ready, false);
  assert.equal(plan.reason, 'unverified_gameplay');
});

test('fewer than three independently selectable clips are held', () => {
  const plan = buildLiveHighlightAgentPlan(sample(900, 2));
  assert.equal(plan.ready, false);
  assert.equal(plan.reason, 'insufficient_short_candidates');
});

test('mismatched evidence is rejected', () => {
  const input = sample();
  input.selection.evidence.pop();
  assert.equal(buildLiveHighlightAgentPlan(input).reason, 'selection_evidence_mismatch');
});
