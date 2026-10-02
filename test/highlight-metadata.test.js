const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTimestamp,
  buildHighlightTimeline,
  buildHighlightDescription
} = require('../src/highlight-metadata');
const { thumbnailHeadline, thumbnailFilter } = require('../src/video');

test('measured segment lengths produce verified chapter timestamps from zero', () => {
  const timeline = buildHighlightTimeline([
    { title: 'Opening duel' },
    { title: 'Close parry' },
    { title: 'Final exchange' }
  ], [12.24, 18.8, 11.1]);

  assert.deepEqual(timeline.timestamps.map((item) => item.time), ['0:00', '0:12', '0:31']);
  assert.equal(formatTimestamp(3661), '1:01:01');
  assert.deepEqual(timeline.chapters.map((item) => item.time), ['0:00', '0:12', '0:31']);
  assert.match(buildHighlightDescription('123456', timeline), /Chapters\n0:00 - Opening duel/);
});

test('short or too few segments remain timestamp links without a chapter heading', () => {
  const shortSegment = buildHighlightTimeline([
    { title: 'First' }, { title: 'Second' }, { title: 'Third' }
  ], [12, 9.99, 12]);
  const twoSegments = buildHighlightTimeline([{ title: 'First' }, { title: 'Second' }], [30, 30]);

  assert.deepEqual(shortSegment.chapters, []);
  assert.deepEqual(twoSegments.chapters, []);
  assert.match(buildHighlightDescription('123456', shortSegment), /Timestamps\n0:00 - First/);
  assert.match(buildHighlightDescription('123456', twoSegments), /Timestamps/);
});

test('invalid clip durations or VOD identifiers are rejected', () => {
  assert.throws(() => buildHighlightTimeline([{ title: 'Moment' }], [0]), /measured positive duration/);
  assert.throws(() => buildHighlightTimeline([{ title: 'Moment' }], []), /matching clip and duration lists/);
  assert.throws(() => buildHighlightDescription('not-a-vod', {
    timestamps: [{ time: '0:00', title: 'Moment' }], chapters: []
  }), /numeric Twitch VOD ID/);
});

test('thumbnail headline is brief and safe for a high-contrast overlay', () => {
  assert.equal(thumbnailHeadline('💀 Insane parries! In Songbird Arena'), 'INSANE PARRIES IN SONGBIRD');
  assert.equal(thumbnailHeadline(''), 'SAEVOND HIGHLIGHT');
  const filter = thumbnailFilter('CLUTCH: Final Exchange');
  assert.match(filter, /scale=1280:720/);
  assert.match(filter, /drawbox=.*drawtext=/);
  assert.doesNotMatch(filter, /CLUTCH:/);
});
