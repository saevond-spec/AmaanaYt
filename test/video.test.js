const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const { createThumbnail, createThumbnailFromImage, thumbnailDimensions, thumbnailHeadline, thumbnailOverlay } = require('../src/video');

function jpegDimensions(buffer) {
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = buffer.readUInt16BE(offset);
    if (startOfFrame.has(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

test('thumbnail headlines remove filler words and stay within four words', () => {
  const headline = thumbnailHeadline('I fought the final boss in ARC Raiders');
  assert.equal(headline, 'FOUGHT FINAL BOSS ARC');
  assert.ok(headline.split(/\s+/).length <= 4);
  assert.ok(headline.length <= 22);
});

test('existing public thumbnail can be composed into a 1280x720 JPEG', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-thumbnail-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.png');
  const output = path.join(directory, 'result.jpg');
  await fs.writeFile(source, thumbnailOverlay('CURRENT IMAGE'));
  await createThumbnailFromImage(source, output, { headline: 'FINAL FIGHT' });
  const image = await fs.readFile(output);
  assert.equal(image[0], 0xff);
  assert.equal(image[1], 0xd8);
  assert.deepEqual(jpegDimensions(image), { width: 1280, height: 720 });
  assert.ok(image.length < 50 * 1024 * 1024);
});

test('thumbnail composition preserves available source detail and caps output at 4K', async (t) => {
  assert.deepEqual(thumbnailDimensions(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(thumbnailDimensions(2560, 1440), { width: 2560, height: 1440 });
  assert.deepEqual(thumbnailDimensions(7680, 4320), { width: 3840, height: 2160 });
  assert.deepEqual(thumbnailDimensions(480, 360), { width: 640, height: 360 });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-thumbnail-hires-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source-1920.png');
  const output = path.join(directory, 'result-1920.jpg');
  await fs.writeFile(source, thumbnailOverlay('HIGH DETAIL', 1920, 1080));
  await createThumbnailFromImage(source, output, {
    headline: 'FINAL FIGHT', sourceWidth: 1920, sourceHeight: 1080
  });
  const image = await fs.readFile(output);
  assert.deepEqual(jpegDimensions(image), { width: 1920, height: 1080 });
});

test('thumbnail frame extraction uses the original video source resolution', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-video-thumbnail-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const frame = path.join(directory, 'source.png');
  const source = path.join(directory, 'source.mp4');
  const output = path.join(directory, 'thumbnail.jpg');
  await fs.writeFile(frame, thumbnailOverlay('ORIGINAL SOURCE', 1920, 1080));
  const fixture = spawnSync(ffmpegPath, ['-y', '-loop', '1', '-i', frame, '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '1', source], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr || fixture.error?.message);
  await createThumbnail(source, output, { timestampSeconds: 0, headline: 'ORIGINAL SOURCE' });
  const image = await fs.readFile(output);
  assert.deepEqual(jpegDimensions(image), { width: 1920, height: 1080 });
});
