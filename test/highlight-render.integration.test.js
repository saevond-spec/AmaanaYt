'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const { assembleHighlights, createThumbnail, shortFromHighlight } = require('../src/video');

function inspectMedia(file) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const output = (result.stderr || '') + (result.stdout || '');
  const duration = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const dimensions = output.match(/Video:.*?(\d{2,4})x(\d{2,4})/);
  return {
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null
  };
}

test('real FFmpeg produces a measured landscape montage, vertical Short, and 16:9 thumbnail', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-render-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = [0, 1].map((index) => path.join(directory, 'source-' + index + '.mp4'));
  for (let index = 0; index < sources.length; index += 1) {
    const fixture = spawnSync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=' + (440 + index * 110) + ':sample_rate=48000',
      '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sources[index]
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, 'FFmpeg fixture should render: ' + fixture.stderr);
  }

  const montage = path.join(directory, 'montage.mp4');
  const durations = await assembleHighlights(sources, montage, directory);
  assert.equal(durations.length, 2);
  assert.ok(durations.every((duration) => duration > 2.8 && duration < 3.2));
  const montageInfo = inspectMedia(montage);
  assert.deepEqual([montageInfo.width, montageInfo.height], [1280, 720]);
  assert.ok(montageInfo.seconds > 5.8 && montageInfo.seconds < 6.3);

  const short = path.join(directory, 'short.mp4');
  await shortFromHighlight(montage, 0, Math.min(2.5, durations[0]), short);
  const shortInfo = inspectMedia(short);
  assert.deepEqual([shortInfo.width, shortInfo.height], [720, 1280]);
  assert.ok(shortInfo.seconds > 2.2 && shortInfo.seconds < 2.8);

  const thumbnail = path.join(directory, 'thumbnail.jpg');
  await createThumbnail(montage, thumbnail, { timestampSeconds: 1, headline: 'REAL RENDER CHECK' });
  const thumbnailInfo = inspectMedia(thumbnail);
  assert.deepEqual([thumbnailInfo.width, thumbnailInfo.height], [1280, 720]);
  assert.ok((await fs.stat(thumbnail)).size > 1000);
});
