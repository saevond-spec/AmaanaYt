const { spawn } = require('child_process');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

function convertLandscapeToShort(inputPath, outputPath) {
  if (!ffmpegPath) throw new Error('FFmpeg is not available');
  const filter = [
    '[0:v]split=2[bgsrc][fgsrc]',
    '[bgsrc]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=18:2[bg]',
    '[fgsrc]scale=720:1280:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]'
  ].join(';');
  const args = [
    '-y', '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-t', '60',
    outputPath
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-5000); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Video formatting timed out'));
    }, 5 * 60 * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

function runFfmpeg(args, timeout = 15 * 60 * 1000) {
  if (!ffmpegPath) throw new Error('FFmpeg is not available');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}

// Normalize every source so concat timestamps, codecs and dimensions match.
async function assembleHighlights(sources, outputPath, segmentDir) {
  const normalized = [];
  const durations = [];
  for (let i = 0; i < sources.length; i += 1) {
    const target = require('path').join(segmentDir, `segment-${i}.mp4`);
    await runFfmpeg(['-y', '-i', sources[i], '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', target]);
    normalized.push(target);
    durations.push(await mediaDuration(target));
  }
  const list = require('path').join(segmentDir, 'concat.txt');
  await require('fs').promises.writeFile(list, normalized.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outputPath]);
  return durations;
}

function mediaDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const match = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (!match) return reject(new Error('Could not measure highlight segment'));
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
  });
}

async function shortFromHighlight(highlightPath, start, duration, outputPath) {
  await runFfmpeg(['-y', '-ss', String(start), '-i', highlightPath, '-t', String(duration),
    '-vf', 'split=2[bgsrc][fgsrc];[bgsrc]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=18:2[bg];[fgsrc]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p',
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', outputPath]);
}


function thumbnailHeadline(title) {
  const words = String(title || '').normalize('NFKC').toLocaleUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const selected = [];
  for (const word of words) {
    if (selected.length >= 4) break;
    const candidate = selected.concat(word).join(' ');
    if (candidate.length > 28) {
      if (!selected.length) selected.push(Array.from(word).slice(0, 28).join(''));
      break;
    }
    selected.push(word);
  }
  return selected.length ? selected.join(' ') : 'SAEVOND HIGHLIGHT';
}

function escapeFilterText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:')
    .replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]').replace(/;/g, '\\;').replace(/%/g, '\\%');
}

function thumbnailFilter(headline, fontPath) {
  const font = fontPath
    ? "fontfile='" + escapeFilterText(fontPath) + "'"
    : "font='DejaVu Sans'";
  const text = escapeFilterText(thumbnailHeadline(headline));
  return [
    'scale=1280:720:force_original_aspect_ratio=increase',
    'crop=1280:720',
    'drawbox=x=0:y=500:w=iw:h=220:color=black@0.72:t=fill',
    'drawbox=x=0:y=500:w=18:h=220:color=yellow@0.98:t=fill',
    'drawtext=' + font + ":text='" + text +
      "':fontcolor=white:fontsize=64:borderw=5:bordercolor=black:x=(w-text_w)/2:y=h-text_h-58:fix_bounds=1",
    'format=yuv420p'
  ].join(',');
}

async function createThumbnail(inputPath, outputPath, {
  timestampSeconds = 0, headline, fontPath = process.env.THUMBNAIL_FONT_PATH
} = {}) {
  if (!inputPath || !outputPath) throw new Error('A source video and thumbnail output path are required');
  const seek = Number(timestampSeconds);
  if (!Number.isFinite(seek) || seek < 0) throw new Error('Thumbnail timestamp must be non-negative');
  const selectedFont = fontPath && fs.existsSync(fontPath) ? fontPath : null;
  await runFfmpeg([
    '-y', '-ss', String(seek), '-i', inputPath,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', thumbnailFilter(headline, selectedFont),
    '-q:v', '2', outputPath
  ], 2 * 60 * 1000);
}

module.exports = { convertLandscapeToShort, assembleHighlights, shortFromHighlight,
  createThumbnail, thumbnailHeadline, thumbnailFilter };
