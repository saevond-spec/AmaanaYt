const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTimestamp,
  buildHighlightTimeline,
  buildHighlightDescription,
  buildHighlightTitle,
  buildShortTitle,
  buildShortDescription
} = require('../src/highlight-metadata');
const { thumbnailHeadline, thumbnailOverlay, createThumbnail } = require('../src/video');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

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

test('highlight and Short titles and descriptions use their specific moment details', () => {
  const timeline = buildHighlightTimeline([
    { title: 'Last ring shield swap', reason: 'A final 1v3 after recovering the banner' },
    { title: 'Last ring shield swap', reason: 'A final 1v3 after recovering the banner' }
  ], [12, 18]);
  const highlightTitle = buildHighlightTitle('Apex Legends ranked session', timeline);
  const firstTitle = buildShortTitle({ ...timeline.timestamps[0], title: 'Last ring shield swap' },
    'Apex Legends ranked session', [highlightTitle]);
  const secondTitle = buildShortTitle({ ...timeline.timestamps[1], title: 'Last ring shield swap' },
    'Apex Legends ranked session', [highlightTitle, firstTitle]);
  const firstDescription = buildShortDescription('123456', 'abcdefghijk', {
    ...timeline.timestamps[0], title: 'Last ring shield swap', reason: 'A final 1v3 after recovering the banner'
  }, 'Apex Legends ranked session');
  const secondDescription = buildShortDescription('123456', 'abcdefghijk', {
    ...timeline.timestamps[1], title: 'Last ring shield swap', reason: 'A final 1v3 after recovering the banner'
  }, 'Apex Legends ranked session');
  assert.match(highlightTitle, /Last ring shield swap/);
  assert.notEqual(firstTitle, secondTitle);
  assert.ok(firstDescription.startsWith('Last ring shield swap (0:00)'));
  assert.ok(secondDescription.startsWith('Last ring shield swap (0:12)'));
  assert.notEqual(firstDescription, secondDescription);
  assert.ok(firstDescription.includes('Source VOD: https://www.twitch.tv/videos/123456?t=0s'));
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
  assert.throws(() => buildHighlightTimeline([{ title: 'Moment' }], [0]), /measured duration between 5 and 60 seconds/);
  assert.throws(() => buildHighlightTimeline([{ title: 'Moment' }], [4.99]), /measured duration between 5 and 60 seconds/);
  assert.throws(() => buildHighlightTimeline([{ title: 'Moment' }], [60.01]), /measured duration between 5 and 60 seconds/);
  assert.throws(() => buildHighlightTimeline([{ title: 'Moment' }], []), /matching clip and duration lists/);
  assert.throws(() => buildHighlightDescription('not-a-vod', {
    timestamps: [{ time: '0:00', title: 'Moment' }], chapters: []
  }), /numeric Twitch VOD ID/);
});

test('near-repeated Shorts titles get distinct titles with their measured VOD timestamps', () => {
  const first = buildShortTitle({ title: 'Last ring shield swap clutch', startSeconds: 42 }, 'Apex Legends Ranked');
  const second = buildShortTitle({ title: 'Last ring shield swap clutch', startSeconds: 77 },
    'Apex Legends Ranked', [first]);

  assert.notEqual(second, first);
  assert.match(second, /at 1:17$/);
  assert.ok(second.length <= 100);
});

test('thumbnail headline is brief and safe for a high-contrast overlay', () => {
  assert.equal(thumbnailHeadline('💀 Insane parry! Final exchange'), 'INSANE PARRY FINAL');
  assert.equal(thumbnailHeadline(''), 'SAEVOND HIGHLIGHT');
  const overlay = thumbnailOverlay('CLUTCH: Final Exchange');
  assert.equal(overlay.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.doesNotMatch(thumbnailHeadline('CLUTCH: Final Exchange'), /:/);
});


test('thumbnail generation renders a JPEG from an actual video frame', { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-thumbnail-'));
  const source = path.join(directory, 'source.mp4');
  const output = path.join(directory, 'thumbnail.jpg');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
        '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', reject);
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error('FFmpeg test fixture failed: ' + stderr)));
    });
    await createThumbnail(source, output, { timestampSeconds: 0.4, headline: 'FINAL CLUTCH' });
    const image = await fs.readFile(output);
    assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
    assert.ok(image.length > 1000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});