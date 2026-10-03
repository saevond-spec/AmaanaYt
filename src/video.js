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

async function inspectMedia(inputPath) {
  if (!ffmpegPath) throw new Error('FFmpeg is not available');
  const stderr = await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); resolve(output); });
  });
  const duration = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = stderr.match(/Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (!duration || !dimensions) throw new Error('Could not verify rendered video duration and dimensions');
  return {
    durationSeconds: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: Number(dimensions[1]),
    height: Number(dimensions[2])
  };
}

function durationMatches(actual, expected) {
  const tolerance = Math.max(1.5, Math.min(3, Number(expected) * 0.02));
  return Number.isFinite(Number(expected)) && Number(expected) > 0 &&
    Math.abs(actual - Number(expected)) <= tolerance;
}

async function validateHighlight(filePath, expectedDuration) {
  const media = await inspectMedia(filePath);
  const aspect = media.width / media.height;
  if (media.width < 640 || media.height < 360 || aspect < 1.7 || aspect > 1.85 ||
      !durationMatches(media.durationSeconds, expectedDuration)) {
    throw new Error('Rendered highlight failed landscape resolution, aspect, or duration checks');
  }
  return media;
}

async function validateShort(filePath, expectedDuration) {
  const media = await inspectMedia(filePath);
  const aspect = media.width / media.height;
  if (media.width < 360 || media.height < 640 || aspect < 0.55 || aspect > 0.575 ||
      media.durationSeconds < 5 || media.durationSeconds > 60 ||
      !durationMatches(media.durationSeconds, expectedDuration)) {
    throw new Error('Rendered Short failed vertical resolution, aspect, or duration checks');
  }
  return media;
}

async function mediaDuration(inputPath) {
  return (await inspectMedia(inputPath)).durationSeconds;
}

async function shortFromHighlight(highlightPath, start, duration, outputPath) {
  await runFfmpeg(['-y', '-ss', String(start), '-i', highlightPath, '-t', String(duration),
    '-vf', 'split=2[bgsrc][fgsrc];[bgsrc]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=18:2[bg];[fgsrc]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p',
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', outputPath]);
}


const zlib = require('zlib');

const THUMBNAIL_GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110']
};

function thumbnailHeadline(title) {
  const words = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const filler = new Set(['A', 'AN', 'AND', 'ARE', 'AS', 'AT', 'BUT', 'BY', 'DID', 'DO', 'FOR',
    'FROM', 'HOW', 'I', 'IN', 'IS', 'IT', 'MY', 'OF', 'ON', 'OR', 'THE', 'THIS', 'TO', 'WE', 'WHAT',
    'WHEN', 'WHERE', 'WHICH', 'WHO', 'WHY', 'WITH', 'YOU']);
  const useful = words.filter((word) => !filler.has(word));
  const selected = [];
  for (const word of useful.length ? useful : words) {
    if (selected.length >= 4) break;
    const candidate = selected.concat(word).join(' ');
    if (candidate.length > 22) {
      if (!selected.length) selected.push(word.slice(0, 22));
      break;
    }
    selected.push(word);
  }
  return selected.length ? selected.join(' ') : 'SAEVOND HIGHLIGHT';
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

function pngImage(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function fillRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * width + column) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}

function thumbnailOverlay(headline) {
  const width = 1280;
  const height = 720;
  const pixels = Buffer.alloc(width * height * 4);
  fillRect(pixels, width, height, 0, 500, width, 220, [0, 0, 0, 210]);
  fillRect(pixels, width, height, 0, 500, 18, 220, [255, 214, 0, 255]);

  const text = thumbnailHeadline(headline);
  const scale = Math.max(8, Math.min(10, Math.floor(1120 / (Math.max(1, text.length) * 6))));
  const textWidth = text.length * 6 * scale;
  let x = Math.floor((width - textWidth) / 2);
  const y = 500 + Math.floor((220 - 7 * scale) / 2);
  const white = [255, 255, 255, 255];
  const outline = [0, 0, 0, 255];
  for (const character of text) {
    const glyph = THUMBNAIL_GLYPHS[character];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < glyph[row].length; column += 1) {
          if (glyph[row][column] !== '1') continue;
          const left = x + column * scale;
          const top = y + row * scale;
          fillRect(pixels, width, height, left - 2, top - 2, scale + 4, scale + 4, outline);
          fillRect(pixels, width, height, left, top, scale, scale, white);
        }
      }
    }
    x += 6 * scale;
  }
  return pngImage(width, height, pixels);
}

async function createThumbnail(inputPath, outputPath, { timestampSeconds = 0, headline } = {}) {
  if (!inputPath || !outputPath) throw new Error('A source video and thumbnail output path are required');
  const seek = Number(timestampSeconds);
  if (!Number.isFinite(seek) || seek < 0) throw new Error('Thumbnail timestamp must be non-negative');
  const overlayPath = outputPath.replace(/\.[^.]+$/, '') + '-overlay.png';
  await fs.promises.writeFile(overlayPath, thumbnailOverlay(headline));
  try {
    await runFfmpeg([
      '-y', '-ss', String(seek), '-i', inputPath, '-i', overlayPath,
      '-filter_complex',
      '[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720[base];' +
        '[base][1:v]overlay=0:0:format=auto,format=yuv420p[out]',
      '-map', '[out]', '-frames:v', '1', '-q:v', '2', outputPath
    ], 2 * 60 * 1000);
  } finally {
    await fs.promises.rm(overlayPath, { force: true }).catch(() => {});
  }
}


async function createThumbnailFromImage(inputPath, outputPath, { headline } = {}) {
  if (!inputPath || !outputPath || !String(headline || '').trim()) {
    throw new Error('A source thumbnail, output path, and headline are required');
  }
  const overlayPath = outputPath.replace(/\.[^.]+$/, '') + '-overlay.png';
  await fs.promises.writeFile(overlayPath, thumbnailOverlay(headline));
  try {
    await runFfmpeg([
      '-y', '-i', inputPath, '-i', overlayPath,
      '-filter_complex',
      '[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720[base];' +
        '[base][1:v]overlay=0:0:format=auto,format=yuv420p[out]',
      '-map', '[out]', '-frames:v', '1', '-q:v', '2', outputPath
    ], 2 * 60 * 1000);
  } finally {
    await fs.promises.rm(overlayPath, { force: true }).catch(() => {});
  }
}

module.exports = { convertLandscapeToShort, assembleHighlights, shortFromHighlight, inspectMedia,
  validateHighlight, validateShort, createThumbnail, createThumbnailFromImage, thumbnailHeadline, thumbnailOverlay };