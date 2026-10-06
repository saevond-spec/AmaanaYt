const { makeDistinctTitle } = require('./metadata-uniqueness');

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

function cleanMetadataLabel(value, limit = 100) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function buildHighlightTitle(streamTitle, timeline, seenTitles = []) {
  if (!timeline || !Array.isArray(timeline.timestamps) || !timeline.timestamps.length) {
    throw new Error('At least one measured highlight timestamp is required');
  }
  const first = timeline.timestamps[0];
  const momentTitle = cleanMetadataLabel(first.title || 'Best moments', 64);
  const stream = cleanMetadataLabel(streamTitle || 'Saevond livestream', 24);
  return makeDistinctTitle(`Highlights: ${stream} — ${momentTitle}`, `moment 1 at ${first.time}`, seenTitles, 100);
}

function buildShortTitle(moment, streamTitle, seenTitles = []) {
  const title = cleanMetadataLabel(moment?.title || 'Livestream highlight', 64);
  const time = formatTimestamp(moment?.startSeconds);
  const stream = cleanMetadataLabel(streamTitle || 'Saevond livestream', 30);
  const candidate = `${title} | ${stream}`;
  return makeDistinctTitle(candidate, `at ${time}`, seenTitles, 100);
}

function buildShortDescription(vodId, highlightVideoId, moment, streamTitle = '') {
  const id = String(vodId || '');
  if (!/^\d+$/.test(id)) throw new Error('A numeric Twitch VOD ID is required');
  if (!String(highlightVideoId || '').trim()) throw new Error('A highlight video ID is required');
  const time = formatTimestamp(moment?.startSeconds);
  const title = cleanMetadataLabel(moment?.title || 'Livestream highlight');
  const reason = cleanMetadataLabel(moment?.reason || '', 500);
  const stream = cleanMetadataLabel(streamTitle || 'Saevond livestream', 100);
  const opening = `${title} (${time})${reason ? ` — ${reason}` : ''}`;
  return [
    opening,
    `From ${stream}.`,
    `Source VOD: https://www.twitch.tv/videos/${id}?t=${Math.floor(Number(moment.startSeconds))}s`,
    `Full highlights: https://youtu.be/${String(highlightVideoId).trim()}`,
    '#Saevond #Shorts'
  ].join('\n');
}

function buildHighlightDescription(vodId, timeline, streamTitle = '') {
  const id = String(vodId || '');
  if (!/^\d+$/.test(id)) throw new Error('A numeric Twitch VOD ID is required');
  if (!timeline || !Array.isArray(timeline.timestamps) || !timeline.timestamps.length) {
    throw new Error('At least one measured highlight timestamp is required');
  }
  const useChapters = timeline.chapters.length >= 3;
  const openingParts = [cleanMetadataLabel(streamTitle || 'Saevond livestream', 80),
    ...timeline.timestamps.slice(0, 2).map((item) => cleanMetadataLabel(item.title, 100))]
    .filter((part, index, all) => part && all.findIndex((candidate) =>
      candidate.toLocaleLowerCase() === part.toLocaleLowerCase()) === index);
  return [
    `Highlights: ${openingParts.join(' — ')}`,
    'Full Twitch VOD: https://www.twitch.tv/videos/' + id,
    '',
    useChapters ? 'Chapters' : 'Timestamps',
    ...timeline.timestamps.map((item) => item.time + ' - ' + item.title),
    '',
    '#Saevond #Gaming'
  ].join('\n');
}

module.exports = { formatTimestamp, buildHighlightTimeline, buildHighlightDescription,
  buildHighlightTitle, buildShortTitle, buildShortDescription };