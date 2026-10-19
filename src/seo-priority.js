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

function isFreshUpload(candidate, now) {
  const publishedAt = Date.parse(candidate?.publishedAt || '');
  const windowMs = 14 * 24 * 60 * 60 * 1000;
  return Number.isFinite(publishedAt) && publishedAt <= now + 24 * 60 * 60 * 1000 &&
    publishedAt >= now - windowMs;
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
 * Fresh uploads go first. Older candidates retain the ready/low-view order,
 * with unknown counts last and evidence gaps, age, and ID breaking ties.
 */
function prioritizeSeoAutoCandidates(candidates, limit = 20, now = Date.now()) {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
  return [...(Array.isArray(candidates) ? candidates : [])]
    .sort((left, right) => {
      const freshOrder = Number(isFreshUpload(right, now)) - Number(isFreshUpload(left, now));
      if (freshOrder) return freshOrder;
      if (isFreshUpload(left, now) && isFreshUpload(right, now)) {
        const publishedOrder = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
        if (publishedOrder) return publishedOrder;
      }
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

module.exports = { prioritizeSeoAutoCandidates, isFreshUpload };
