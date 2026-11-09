'use strict';

// Coordinating specialists reuse AmaanaYT's existing verified AI and media workers.
// This planner never grants publication privileges or changes existing videos.
const LIVE_TARGET_SECONDS = 15 * 60;
const LIVE_SHORT_COUNT = 3;

function buildLiveHighlightAgentPlan({ selection, candidateById, streamId, batchIndex }) {
  const moments = selection?.highlights || [];
  const evidence = selection?.evidence || [];
  const duration = moments.reduce((sum, moment) => sum + Number(moment.duration || 0), 0);
  if (Math.abs(duration - LIVE_TARGET_SECONDS) > 0.1) {
    return { ready: false, reason: 'insufficient_verified_gameplay', durationSeconds: duration };
  }
  if (moments.length !== evidence.length) {
    return { ready: false, reason: 'selection_evidence_mismatch', durationSeconds: duration };
  }
  const candidates = evidence.map((item) => candidateById.get(String(item.clipId)));
  if (candidates.some((candidate) => !candidate?.clip?.visualGameplayVerification?.verified)) {
    return { ready: false, reason: 'unverified_gameplay', durationSeconds: duration };
  }
  if (evidence.length < LIVE_SHORT_COUNT) {
    return { ready: false, reason: 'insufficient_short_candidates', durationSeconds: duration };
  }
  const ranked = evidence.map((item, index) => ({
    index, score: Number(item?.selectionScore) || 0
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const shortCandidateIndexes = ranked.slice(0, LIVE_SHORT_COUNT).map((item) => item.index);
  return {
    ready: true,
    shortCandidateIndexes,
    agentPlan: {
      version: 1,
      mode: 'live_highlight_autopilot',
      streamId: String(streamId),
      batchIndex,
      generatedAt: new Date().toISOString(),
      requirements: { highlightDurationSeconds: LIVE_TARGET_SECONDS, shorts: LIVE_SHORT_COUNT },
      specialists: [
        { id: 'gameplay-analyst', result: 'verified', evidenceCount: candidates.length },
        { id: 'highlight-editor', result: 'queued', targetSeconds: LIVE_TARGET_SECONDS },
        { id: 'shorts-editor', result: 'queued', indexes: shortCandidateIndexes },
        { id: 'seo-specialist', result: 'pending_worker' },
        { id: 'quality-controller', result: 'pending_media_and_youtube_checks' },
        { id: 'publishing-manager', result: 'gated_by_existing_publication_policy' }
      ]
    }
  };
}

module.exports = { LIVE_TARGET_SECONDS, LIVE_SHORT_COUNT, buildLiveHighlightAgentPlan };
