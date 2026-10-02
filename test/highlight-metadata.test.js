const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTimestamp,
  buildHighlightTimeline,
  buildHighlightDescription
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
