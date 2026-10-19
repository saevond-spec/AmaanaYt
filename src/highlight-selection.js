'use strict';

const { parseTwitchDuration, validateHighlightMoments } = require('./highlight-validation');

const TARGET_HIGHLIGHT_DURATION_SECONDS = 15 * 60;
const MAX_HIGHLIGHT_SEGMENTS = 20;
const MIN_GAMEPLAY_SEGMENT_SECONDS = 15;
const MAX_CLIP_SECONDS = 60;
const MAX_CANDIDATES_FOR_OPTIMIZATION = 160;

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function clipQuality(candidate, maxViews, vodCreatedAt, coverageBinCounts) {
  const engagement = maxViews > 0
    ? Math.log1p(candidate.viewCount) / Math.log1p(maxViews) : 0;
  const ageHours = candidate.createdAt && vodCreatedAt
    ? Math.abs(candidate.createdAt - vodCreatedAt) / (60 * 60 * 1000) : 0;
  const freshness = Math.exp(-ageHours / 48);
  // Downweight crowded five-minute windows; this rewards sparse parts of the VOD without
  // hard-coding a preference for either the opening or the ending of the stream.
  const temporalCoverage = 1 / Math.sqrt(coverageBinCounts.get(candidate.coverageBin) || 1);
  // Log engagement prevents one viral clip from overwhelming every other signal.
  return 0.65 * engagement + 0.25 * freshness + 0.10 * temporalCoverage;
}

function previousCompatibleCount(candidates, index) {
  const start = candidates[index].startSeconds - 3;
  let low = 0;
  let high = index;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candidates[middle].endSeconds <= start) low = middle + 1;
    else high = middle;
  }
  return low;
}

function reconstruct(candidates, previousCounts, choice, stateWidth, rowWidth, count, seconds) {
  const selected = [];
  let row = candidates.length;
  while (row > 0 && count > 0) {
    const state = seconds * stateWidth + count;
    if (choice[row * rowWidth + state]) {
      const candidate = candidates[row - 1];
      selected.push(candidate);
      seconds -= candidate.durationUnits;
      count -= 1;
      row = previousCounts[row - 1];
    } else {
      row -= 1;
    }
  }
  return selected.sort((left, right) => left.startSeconds - right.startSeconds);
}

function select15MinuteGameplayHighlights(clips, vod, {
  targetDurationSeconds = TARGET_HIGHLIGHT_DURATION_SECONDS,
  maxSegments = MAX_HIGHLIGHT_SEGMENTS,
  minSegmentSeconds = MIN_GAMEPLAY_SEGMENT_SECONDS,
  maxCandidates = MAX_CANDIDATES_FOR_OPTIMIZATION
} = {}) {
  const vodId = String(vod && vod.id || '');
  const broadcasterId = String(vod && vod.user_id || '');
  const vodDurationSeconds = parseTwitchDuration(vod && vod.duration);
  const target = Number(targetDurationSeconds);
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error('A positive whole-second highlight target is required');
  const segmentLimit = Math.max(1, Math.min(MAX_HIGHLIGHT_SEGMENTS, Math.floor(Number(maxSegments) || MAX_HIGHLIGHT_SEGMENTS)));
  const minimum = Math.max(5, Math.min(MAX_CLIP_SECONDS, Number(minSegmentSeconds) || MIN_GAMEPLAY_SEGMENT_SECONDS));
  const candidates = (Array.isArray(clips) ? clips : []).flatMap((clip) => {
    if (!clip || !clip.id || String(clip.video_id || '') !== vodId ||
        broadcasterId && String(clip.broadcaster_id || '') !== broadcasterId ||
        !String(clip.game_id || '').trim()) return [];
    const startSeconds = clip.vod_offset === null || clip.vod_offset === undefined || clip.vod_offset === ''
      ? NaN : Number(clip.vod_offset);
    const rawDuration = clip.duration === null || clip.duration === undefined || clip.duration === ''
      ? NaN : Number(clip.duration);
    const duration = Math.min(rawDuration, MAX_CLIP_SECONDS);
    const endSeconds = startSeconds + duration;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(rawDuration) || !Number.isFinite(duration) ||
        startSeconds < 0 || rawDuration > MAX_CLIP_SECONDS || duration < minimum ||
        endSeconds > vodDurationSeconds + 0.25) return [];
    return [{
      clipId: String(clip.id),
      gameId: String(clip.game_id),
      title: clean(clip.title, 100) || 'Twitch gameplay clip',
      viewCount: positiveNumber(clip.view_count),
      createdAt: Date.parse(clip.created_at || '') || 0,
      startSeconds: Number(startSeconds.toFixed(1)),
      endSeconds: Number(endSeconds.toFixed(1)),
      duration: Number(duration.toFixed(1))
    }];
  });
  const maxViews = Math.max(0, ...candidates.map((candidate) => candidate.viewCount));
  const vodCreatedAt = Date.parse(vod && vod.created_at || '') || 0;
  const coverageBinCount = Math.max(1, Math.ceil(vodDurationSeconds / (5 * 60)));
  const coverageBinWidth = vodDurationSeconds / coverageBinCount;
  const coverageBinCounts = new Map();
  for (const candidate of candidates) {
    candidate.coverageBin = Math.min(coverageBinCount - 1,
      Math.floor((candidate.startSeconds + candidate.duration / 2) / coverageBinWidth));
    coverageBinCounts.set(candidate.coverageBin, (coverageBinCounts.get(candidate.coverageBin) || 0) + 1);
  }
  for (const candidate of candidates) {
    candidate.quality = clipQuality(candidate, maxViews, vodCreatedAt, coverageBinCounts);
    candidate.durationUnits = Math.max(1, Math.round(candidate.duration));
  }
  const optimizationCandidates = candidates
    .sort((left, right) => right.quality - left.quality || right.viewCount - left.viewCount ||
      left.startSeconds - right.startSeconds || left.clipId.localeCompare(right.clipId))
    .slice(0, Math.max(1, Math.min(MAX_CANDIDATES_FOR_OPTIMIZATION, Math.floor(Number(maxCandidates) || MAX_CANDIDATES_FOR_OPTIMIZATION))))
    .sort((left, right) => left.endSeconds - right.endSeconds || left.startSeconds - right.startSeconds ||
      left.clipId.localeCompare(right.clipId));

  if (!optimizationCandidates.length) {
    return { vodDurationSeconds, targetDurationSeconds: target, highlights: [], evidence: [],
      rejectionReason: 'no_game_category_clips', availableGameplaySeconds: 0 };
  }

  // Weighted interval knapsack: maximize clip quality while enforcing non-overlap,
  // the 15-minute duration target, and a finite edit cut count.
  const maxTotalSeconds = target + MAX_CLIP_SECONDS;
  const countWidth = segmentLimit + 1;
  const stateWidth = countWidth;
  const durationWidth = maxTotalSeconds + 1;
  const rowWidth = durationWidth * stateWidth;
  const previousCounts = optimizationCandidates.map((_candidate, index) =>
    previousCompatibleCount(optimizationCandidates, index));
  const rows = new Array(optimizationCandidates.length + 1);
  const choice = new Uint8Array((optimizationCandidates.length + 1) * rowWidth);
  rows[0] = new Float64Array(rowWidth);
  rows[0].fill(Number.NEGATIVE_INFINITY);
  rows[0][0] = 0;

  for (let index = 1; index <= optimizationCandidates.length; index += 1) {
    const candidate = optimizationCandidates[index - 1];
    const current = new Float64Array(rows[index - 1]);
    rows[index] = current;
    const prior = rows[previousCounts[index - 1]];
    const segmentScore = Math.round(candidate.quality * 1_000_000);
    for (let seconds = 0; seconds + candidate.durationUnits <= maxTotalSeconds; seconds += 1) {
      const nextSeconds = seconds + candidate.durationUnits;
      for (let count = 0; count < segmentLimit; count += 1) {
        const previousState = seconds * stateWidth + count;
        const baseScore = prior[previousState];
        if (!Number.isFinite(baseScore)) continue;
        const nextState = nextSeconds * stateWidth + count + 1;
        const score = baseScore + segmentScore;
        if (score > current[nextState]) {
          current[nextState] = score;
          choice[index * rowWidth + nextState] = 1;
        }
      }
    }
  }

  const finalRow = rows[optimizationCandidates.length];
  const solutions = [];
  for (let seconds = target; seconds <= maxTotalSeconds; seconds += 1) {
    for (let count = 1; count <= segmentLimit; count += 1) {
      const state = seconds * stateWidth + count;
      const score = finalRow[state];
      if (!Number.isFinite(score)) continue;
      const selected = reconstruct(optimizationCandidates, previousCounts, choice, stateWidth, rowWidth, count, seconds);
      if (!selected.length) continue;
      const prefixDuration = selected.slice(0, -1).reduce((sum, candidate) => sum + candidate.duration, 0);
      const finalDuration = Number((target - prefixDuration).toFixed(1));
      if (finalDuration < minimum || finalDuration > selected[selected.length - 1].duration + 0.25) continue;
      const actualTotal = prefixDuration + finalDuration;
      const adjustedScore = score - Math.round((actualTotal - target) * 10_000) - count * 100;
      solutions.push({ selected, finalDuration, adjustedScore });
    }
  }
  solutions.sort((left, right) => right.adjustedScore - left.adjustedScore ||
    left.selected.length - right.selected.length);

  if (!solutions.length) {
    const byEnd = [...optimizationCandidates].sort((left, right) => left.endSeconds - right.endSeconds);
    const nonOverlapping = [];
    for (const candidate of byEnd) {
      if (nonOverlapping.length >= segmentLimit) break;
      if (!nonOverlapping.some((selected) =>
        Math.min(selected.endSeconds, candidate.endSeconds) > Math.max(selected.startSeconds, candidate.startSeconds) ||
        Math.abs(selected.endSeconds - candidate.endSeconds) < 3)) nonOverlapping.push(candidate);
    }
    const availableGameplaySeconds = Number(nonOverlapping.reduce((sum, candidate) => sum + candidate.duration, 0).toFixed(1));
    return { vodDurationSeconds, targetDurationSeconds: target, highlights: [], evidence: [],
      rejectionReason: 'insufficient_non_overlapping_gameplay_duration', availableGameplaySeconds };
  }

  const best = solutions[0];
  const moments = best.selected.map((candidate, index) => {
    const duration = index === best.selected.length - 1 ? best.finalDuration : candidate.duration;
    const endSeconds = Number((candidate.startSeconds + duration).toFixed(1));
    return {
      startSeconds: candidate.startSeconds,
      endSeconds,
      duration,
      title: candidate.title,
      reason: `Twitch game category ${candidate.gameId}; ${candidate.viewCount} community views`,
      score: Number((candidate.quality * 100).toFixed(2))
    };
  });
  const highlights = validateHighlightMoments(moments, vodDurationSeconds);
  const evidenceByMoment = new Map(best.selected.map((candidate, index) => {
    const selectedDuration = index === best.selected.length - 1 ? best.finalDuration : candidate.duration;
    return [`${candidate.startSeconds}:${selectedDuration}`, {
      clipId: candidate.clipId, gameId: candidate.gameId, title: candidate.title,
      viewCount: candidate.viewCount, createdAt: candidate.createdAt ? new Date(candidate.createdAt).toISOString() : null,
      startSeconds: candidate.startSeconds, duration: selectedDuration,
      selectionScore: Number((candidate.quality * 100).toFixed(2))
    }];
  }));
  return {
    vodDurationSeconds,
    targetDurationSeconds: target,
    highlights,
    evidence: highlights.map((moment) => evidenceByMoment.get(`${moment.startSeconds}:${moment.duration}`)).filter(Boolean),
    availableGameplaySeconds: target,
    rejectionReason: null
  };
}

module.exports = {
  select15MinuteGameplayHighlights,
  TARGET_HIGHLIGHT_DURATION_SECONDS,
  MAX_HIGHLIGHT_SEGMENTS,
  MIN_GAMEPLAY_SEGMENT_SECONDS
};
