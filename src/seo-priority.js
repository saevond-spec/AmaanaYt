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

function viewCount(candidate) {
  const value = String(candidate?.viewCount ?? '');
  if (!/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function compareViewCounts(left, right) {
  const a = viewCount(left);
  const b = viewCount(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Keep publish-ready packages first, then put known low-view public videos ahead.
 * Unknown counts follow known counts; evidence gaps and age break ties.
 */
function prioritizeSeoAutoCandidates(candidates, limit = 20) {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
  return [...(Array.isArray(candidates) ? candidates : [])]
    .sort((left, right) => {
      const statusOrder = (left.status === 'ready' ? 0 : 1) - (right.status === 'ready' ? 0 : 1);
      if (statusOrder) return statusOrder;
      const viewOrder = compareViewCounts(left, right);
      if (viewOrder) return viewOrder;
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
