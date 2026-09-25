const { spawn } = require('child_process');
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

module.exports = { convertLandscapeToShort };
