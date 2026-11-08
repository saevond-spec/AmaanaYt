const MAX_CAPTURE_SEGMENTS = 4;
const MIN_CAPTURE_SEGMENT_SECONDS = 5;
const MAX_CAPTURE_SEGMENT_SECONDS = 25;
const MAX_CAPTURE_TOTAL_SECONDS = 90;
const MIN_SHORT_SECONDS = 5;
const MAX_SHORT_SECONDS = 60;

function planScreenCaptureShort(segmentWindows, segmentDurations, markerOffsetSeconds, {
  leadSeconds = 10,
  tailSeconds = 15,
  maxDurationSeconds = 30
} = {}) {
  const marker = Number(markerOffsetSeconds);
  if (!Number.isFinite(marker) || marker < 0 || !Array.isArray(segmentWindows) ||
      !Array.isArray(segmentDurations) || segmentWindows.length !== segmentDurations.length ||
      segmentWindows.length < 1 || segmentWindows.length > MAX_CAPTURE_SEGMENTS) {
    throw new Error('Live capture needs one to four measured screen segments and a valid marker time');
  }
  const windows = segmentWindows.map((window, index) => {
    const startSeconds = Number(window?.startSeconds);
    const endSeconds = Number(window?.endSeconds);
    const durationSeconds = Number(segmentDurations[index]);
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(endSeconds) ||
        endSeconds <= startSeconds || endSeconds - startSeconds > MAX_CAPTURE_SEGMENT_SECONDS ||
        !Number.isFinite(durationSeconds) || durationSeconds < MIN_CAPTURE_SEGMENT_SECONDS ||
        durationSeconds > MAX_CAPTURE_SEGMENT_SECONDS) {
      throw new Error('Live screen segment timing or measured duration is invalid');
    }
    return { startSeconds, endSeconds, durationSeconds };
  });
  if (windows.reduce((sum, item) => sum + item.durationSeconds, 0) > MAX_CAPTURE_TOTAL_SECONDS) {
    throw new Error('Live screen capture exceeds the short-draft processing limit');
  }
  const markerIndex = windows.findIndex((item) => marker >= item.startSeconds && marker <= item.endSeconds);
  if (markerIndex < 0) throw new Error('Detected gameplay moment is outside the captured screen segments');

  const targetStart = Math.max(0, marker - Math.max(0, Number(leadSeconds) || 0));
  const targetEnd = marker + Math.max(0, Number(tailSeconds) || 0);
  let firstIndex = windows.findIndex((item) => item.endSeconds >= targetStart);
  let lastIndex = windows.findLastIndex((item) => item.startSeconds <= targetEnd);
  if (firstIndex < 0) firstIndex = markerIndex;
  if (lastIndex < markerIndex) lastIndex = markerIndex;
  firstIndex = Math.min(firstIndex, markerIndex);
  lastIndex = Math.max(lastIndex, markerIndex);
  const selected = windows.slice(firstIndex, lastIndex + 1);
  if (!selected.length || selected.length > MAX_CAPTURE_SEGMENTS) {
    throw new Error('Could not assemble a bounded gameplay clip around the detected moment');
  }

  const markerSegmentIndex = markerIndex - firstIndex;
  const markerInCombinedSeconds = selected.slice(0, markerSegmentIndex)
    .reduce((sum, item) => sum + item.durationSeconds, 0) +
    Math.max(0, Math.min(selected[markerSegmentIndex].durationSeconds,
      marker - selected[markerSegmentIndex].startSeconds));
  const clipStartSeconds = Math.max(0, markerInCombinedSeconds - Math.max(0, Number(leadSeconds) || 0));
  const totalDurationSeconds = selected.reduce((sum, item) => sum + item.durationSeconds, 0);
  const durationSeconds = Math.min(Math.max(MIN_SHORT_SECONDS, Number(maxDurationSeconds) || 30),
    totalDurationSeconds - clipStartSeconds, MAX_SHORT_SECONDS);
  if (durationSeconds < MIN_SHORT_SECONDS || markerInCombinedSeconds >= clipStartSeconds + durationSeconds) {
    throw new Error('Captured gameplay does not contain enough footage for a Short');
  }
  return {
    firstIndex,
    lastIndex,
    markerInCombinedSeconds: Number(markerInCombinedSeconds.toFixed(2)),
    clipStartSeconds: Number(clipStartSeconds.toFixed(2)),
    durationSeconds: Number(durationSeconds.toFixed(2)),
    segmentCount: selected.length
  };
}

module.exports = {
  planScreenCaptureShort,
  MAX_CAPTURE_SEGMENTS,
  MAX_CAPTURE_SEGMENT_SECONDS,
  MAX_CAPTURE_TOTAL_SECONDS,
  MIN_SHORT_SECONDS,
  MAX_SHORT_SECONDS
};
