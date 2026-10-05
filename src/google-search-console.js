function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"' && value.length === 0) quoted = true;
    else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else if (character !== '\r') value += character;
  }
  if (quoted) fail('The CSV has an unfinished quoted field.');
  if (row.length || value) {
    row.push(value);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

function headerKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findHeader(rows) {
  const pageNames = new Set(['page', 'pages', 'toppage', 'toppages', 'post', 'posts',
    'toppost', 'topposts', 'video', 'videos', 'topvideo', 'topvideos',
    'url', 'pageurl', 'posturl', 'videourl']);
  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const headers = rows[index].map(headerKey);
    const pageIndex = headers.findIndex((header) => pageNames.has(header));
    const clicksIndex = headers.indexOf('clicks');
    const impressionsIndex = headers.indexOf('impressions');
    const positionIndex = headers.findIndex((header) =>
      header === 'position' || header === 'averageposition');
    if (pageIndex >= 0 && clicksIndex >= 0 && impressionsIndex >= 0 && positionIndex >= 0) {
      return { index, pageIndex, clicksIndex, impressionsIndex, positionIndex };
    }
  }
  fail('Upload the Search Console Videos, Pages, or Posts CSV with video/page/post URL, clicks, impressions, and position columns.');
}

function numericCell(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '-' || normalized === '~') return 0;
  const compact = normalized.replace(/\s/g, '');
  const decimalComma = label === 'average position' && /^\d+,\d{1,2}$/.test(compact);
  const number = Number(decimalComma ? compact.replace(',', '.') : compact.replace(/,/g, ''));
  if (!Number.isFinite(number) || number < 0) fail('The CSV contains an invalid ' + label + ' value.');
  return number;
}

function extractVideoId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.startsWith('/') ? 'https://www.youtube.com' + raw : raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const candidate = url.pathname.split('/').filter(Boolean)[0];
    return /^[A-Za-z0-9_-]{11}$/.test(candidate || '') ? candidate : null;
  }
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;
  const path = url.pathname.split('/').filter(Boolean);
  let candidate = null;
  if (url.pathname === '/watch') candidate = url.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v'].includes(path[0])) candidate = path[1];
  return /^[A-Za-z0-9_-]{11}$/.test(candidate || '') ? candidate : null;
}

function parseGoogleSearchConsoleCsv(text) {
  const rows = parseCsv(text);
  const columns = findHeader(rows);
  const videos = new Map();
  for (const cells of rows.slice(columns.index + 1)) {
    const videoId = extractVideoId(cells[columns.pageIndex]);
    if (!videoId) continue;
    const clicks = numericCell(cells[columns.clicksIndex], 'clicks');
    const impressions = numericCell(cells[columns.impressionsIndex], 'impressions');
    const position = numericCell(cells[columns.positionIndex], 'average position');
    if (!Number.isSafeInteger(clicks) || !Number.isSafeInteger(impressions)) {
      fail('The CSV contains click or impression counts outside the supported range.');
    }
    const existing = videos.get(videoId) || {
      videoId, clicks: 0, impressions: 0, positionWeighted: 0, positionImpressions: 0
    };
    existing.clicks += clicks;
    existing.impressions += impressions;
    if (position > 0 && impressions > 0) {
      existing.positionWeighted += position * impressions;
      existing.positionImpressions += impressions;
    }
    videos.set(videoId, existing);
  }
  if (!videos.size) {
    fail('No YouTube video URLs were found. Export the Videos, Pages, or Posts table from the @saevond YouTube platform property.');
  }
  return [...videos.values()].map((video) => ({
    videoId: video.videoId,
    clicks: video.clicks,
    impressions: video.impressions,
    averagePosition: video.positionImpressions
      ? Number((video.positionWeighted / video.positionImpressions).toFixed(4)) : null
  }));
}

module.exports = { parseGoogleSearchConsoleCsv, extractVideoId };
