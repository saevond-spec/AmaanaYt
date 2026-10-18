'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const { assembleHighlights, createThumbnail, shortFromHighlight, validateHighlight } = require('../src/video');

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
  const durations = await assembleHighlights(sources, montage, directory, [2.5, 2.7]);
  assert.equal(durations.length, 2);
  assert.ok(durations[0] > 2.3 && durations[0] < 2.65);
  assert.ok(durations[1] > 2.5 && durations[1] < 2.85);
  const montageInfo = inspectMedia(montage);
  assert.deepEqual([montageInfo.width, montageInfo.height], [1280, 720]);
  assert.ok(montageInfo.seconds > 4.8 && montageInfo.seconds < 5.5);

  const exactMontage = path.join(directory, 'exact-montage.mp4');
  await assembleHighlights(sources, exactMontage, directory, [2.5, 2.7], 5);
  const exactInfo = await validateHighlight(exactMontage, 5, { exactDuration: true });
  assert.ok(Math.abs(exactInfo.durationSeconds - 5) <= 0.5);

  await assert.rejects(
    assembleHighlights(sources, path.join(directory, 'too-long.mp4'), directory, [2.5, 2.7], 10),
    /Only .* seconds of landscape gameplay source are available; 10 are required/
  );

  const portrait = path.join(directory, 'portrait.mp4');
  const portraitFixture = spawnSync(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', portrait
  ], { encoding: 'utf8' });
  assert.equal(portraitFixture.status, 0, 'portrait fixture should render');
  await assert.rejects(
    assembleHighlights([portrait], path.join(directory, 'portrait-rejected.mp4'), directory, [1]),
    /landscape gameplay source is required/
  );

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
