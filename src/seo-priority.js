function evidenceGapCount(candidate) {
  if (candidate.status === 'ready') return 0;
  return Number.isSafeInteger(candidate.missingEvidenceCount) && candidate.missingEvidenceCount >= 0
    ? candidate.missingEvidenceCount : Number.MAX_SAFE_INTEGER;
}

function generatedTime(candidate) {
  const value = candidate.generatedAt instanceof Date
    ? candidate.generatedAt.getTime() : Date.parse(candidate.generatedAt || '');
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * Prioritize automatic SEO work by confidence and effort:
 * ready packages first, then review packages with fewer missing-evidence items.
 * Keep FIFO order within equal priorities and use video ID as a stable tie-breaker.
 */
function prioritizeSeoAutoCandidates(candidates, limit = 20) {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
  return [...(Array.isArray(candidates) ? candidates : [])]
    .sort((left, right) => {
      const statusOrder = (left.status === 'ready' ? 0 : 1) - (right.status === 'ready' ? 0 : 1);
      if (statusOrder) return statusOrder;
      const gapOrder = evidenceGapCount(left) - evidenceGapCount(right);
      if (gapOrder) return gapOrder;
      const timeOrder = generatedTime(left) - generatedTime(right);
      if (timeOrder) return timeOrder;
      return String(left.videoId || '').localeCompare(String(right.videoId || ''));
    })
    .slice(0, safeLimit)
    .map(({ videoId }) => ({ videoId }));
}

module.exports = { prioritizeSeoAutoCandidates };
