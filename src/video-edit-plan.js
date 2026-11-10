'use strict';

// Sampled frames prove an instant, not a fight's exact beginning or end.
// Preserve generous context, and all verified markers, rather than invent cuts.
function planGameplayShort(sourceDuration, visual = {}) {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error('A positive measured segment duration is required');
  }
  const endLimit = Math.min(60, sourceDuration);
  const fallback = { version: 1, mode: 'full_segment', startSeconds: 0,
    durationSeconds: endLimit, reason: 'No reliable timestamped event', events: [] };
  if (visual.verified !== true) return fallback;
  const events = (Array.isArray(visual.eventMarkers) ? visual.eventMarkers : []).filter((event) =>
    event && ['fight', 'rare_loot', 'clutch'].includes(event.eventType) &&
    Number.isFinite(event.offsetSeconds) && event.offsetSeconds >= 0 && event.offsetSeconds < endLimit &&
    Number.isFinite(event.confidence) && event.confidence >= 0.8 && event.confidence <= 1 &&
    typeof event.evidence === 'string' && event.evidence.trim()
  ).sort((a, b) => a.offsetSeconds - b.offsetSeconds).map((event) => ({
    eventType: event.eventType, offsetSeconds: event.offsetSeconds,
    confidence: event.confidence, evidence: event.evidence.slice(0, 180)
  }));
  if (!events.length) return fallback;
  const combat = events.some((event) => event.eventType !== 'rare_loot');
  const leadIn = combat ? 10 : 4;
  const aftermath = combat ? 10 : 6;
  let start = Math.max(0, events[0].offsetSeconds - leadIn);
  let end = Math.min(endLimit, events[events.length - 1].offsetSeconds + aftermath);
  const minimum = Math.min(endLimit, combat ? 25 : 15);
  if (end - start < minimum) {
    start = Math.max(0, start - (minimum - (end - start)));
    end = Math.min(endLimit, Math.max(end, start + minimum));
  }
  return { version: 1, mode: 'event_window', startSeconds: start,
    durationSeconds: end - start, reason: 'Verified event with lead-in and aftermath', events };
}

module.exports = { planGameplayShort };
