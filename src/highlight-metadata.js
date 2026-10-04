function formatTimestamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error('Timestamp must be a non-negative number');
  const total = Math.floor(value + 1e-7);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  if (hours) return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  return Math.floor(total / 60) + ':' + String(secs).padStart(2, '0');
}

function cleanMomentTitle(value, index) {
  const title = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return title || 'Moment ' + (index + 1);
}

function buildHighlightTimeline(highlights, segmentDurations) {
  if (!Array.isArray(highlights) || !highlights.length || !Array.isArray(segmentDurations) ||
      highlights.length !== segmentDurations.length || highlights.length > 10) {
    throw new Error('Highlight timestamps need matching clip and duration lists');
  }
  let offset = 0;
  const timestamps = highlights.map((moment, index) => {
    const durationSeconds = Number(segmentDurations[index]);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 60) {
      throw new Error('Every highlight segment needs a measured duration between 5 and 60 seconds');
    }
    const startSeconds = Math.floor(offset + 1e-7);
    const timestamp = {
      startSeconds,
      time: formatTimestamp(startSeconds),
      title: cleanMomentTitle(moment?.title, index),
      durationSeconds
    };
    offset += durationSeconds;
    return timestamp;
  });
  const chaptersValid = timestamps.length >= 3 &&
    timestamps.every((item, index) => item.durationSeconds >= 10 &&
      (index === 0 || item.startSeconds - timestamps[index - 1].startSeconds >= 10)) &&
    offset - timestamps[timestamps.length - 1].startSeconds >= 10;
  return {
    durationSeconds: offset,
    timestamps,
    chapters: chaptersValid ? timestamps : []
  };
}

function buildHighlightDescription(vodId, timeline) {
  const id = String(vodId || '');
  if (!/^\d+$/.test(id)) throw new Error('A numeric Twitch VOD ID is required');
  if (!timeline || !Array.isArray(timeline.timestamps) || !timeline.timestamps.length) {
    throw new Error('At least one measured highlight timestamp is required');
  }
  const useChapters = timeline.chapters.length >= 3;
  return [
    'Highlights from https://www.twitch.tv/videos/' + id,
    '',
    useChapters ? 'Chapters' : 'Timestamps',
    ...timeline.timestamps.map((item) => item.time + ' - ' + item.title),
    '',
    '#Saevond #Gaming'
  ].join('\n');
}

module.exports = { formatTimestamp, buildHighlightTimeline, buildHighlightDescription };