'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { validateHighlight, validateShort } = require('../src/video');

function renderFixture(args, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-y', ...args, output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error('FFmpeg validation fixture failed: ' + stderr)));
  });
}

test('render checks accept measured landscape and vertical outputs and reject the wrong shape', { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-media-validation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const landscapePath = path.join(directory, 'landscape.mp4');
  const shortPath = path.join(directory, 'short.mp4');
  const wrongShapePath = path.join(directory, 'wrong-shape.mp4');

  await renderFixture(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], landscapePath);
  await renderFixture(['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=1',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], shortPath);
  await renderFixture(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], wrongShapePath);

  assert.deepEqual(await validateHighlight(landscapePath, 5),
    { durationSeconds: 5, width: 640, height: 360 });
  assert.deepEqual(await validateShort(shortPath, 5),
    { durationSeconds: 5, width: 360, height: 640 });
  await assert.rejects(validateShort(wrongShapePath, 5), /vertical resolution/);
  await assert.rejects(validateShort(shortPath, 30), /duration checks/);
});
