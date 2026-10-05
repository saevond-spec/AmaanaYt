function isoDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid date is required');
  return date.toISOString().slice(0, 10);
}
function shiftDays(value, amount) {
  const date = new Date(value + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function youtubeSearchComparisonWindows(now = new Date(), delayDays = 3, periodDays = 28) {
  if (!Number.isSafeInteger(delayDays) || delayDays < 0 || delayDays > 30 ||
      !Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 90) {
    throw new Error('Invalid YouTube Analytics reporting window');
  }
  const currentEnd = shiftDays(isoDate(now), -delayDays);
  const currentStart = shiftDays(currentEnd, -(periodDays - 1));
  const previousEnd = shiftDays(currentStart, -1);
  const previousStart = shiftDays(previousEnd, -(periodDays - 1));
  return {
    current: { startDate: currentStart, endDate: currentEnd },
    previous: { startDate: previousStart, endDate: previousEnd }
  };
}
function isGoogleExternalReferrer(value) {
  const source = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (['google search', 'google search results', 'google web search'].includes(source)) return true;
  if (!source) return false;
  let url;
  try { url = new URL(source.includes('://') ? source : 'https://' + source); }
  catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)google\.(?:[a-z]{2,3}\.)?[a-z]{2,}$/i.test(host);
}
function hasYoutubeAnalyticsReadScopes(tokens) {
  const scopes = new Set(String(tokens?.scope || '').split(/\s+/));
  return Boolean((tokens?.refresh_token || tokens?.access_token) &&
    scopes.has('https://www.googleapis.com/auth/youtube.readonly') &&
    scopes.has('https://www.googleapis.com/auth/yt-analytics.readonly'));
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function youtubeSearchReportQueries(videoId, startDate, endDate) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || '')) ||
      !validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error('A video ID and valid YouTube Analytics date range are required');
  }
  const common = { ids: 'channel==MINE', startDate, endDate, metrics: 'views' };
  return [
    { ...common, dimensions: 'insightTrafficSourceType', filters: 'video==' + videoId, sort: '-views' },
    { ...common, dimensions: 'insightTrafficSourceDetail',
      filters: 'video==' + videoId + ';insightTrafficSourceType==EXT_URL',
      sort: '-views', maxResults: 25 }
  ];
}
function metricCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('YouTube Analytics returned an invalid ' + label + ' count');
  }
  return count;
}
function summarizeYoutubeSearchPerformance(trafficRows, externalDetailRows, maxDetailRows = 25) {
  const traffic = Array.isArray(trafficRows) ? trafficRows : [];
  const details = Array.isArray(externalDetailRows) ? externalDetailRows : [];
  if (!Number.isSafeInteger(maxDetailRows) || maxDetailRows < 1) {
    throw new Error('The external source detail cap must be a positive integer');
  }
  const youtubeSearchViews = traffic
    .filter((row) => Array.isArray(row) && String(row[0] || '').toUpperCase() === 'YT_SEARCH')
    .reduce((sum, row) => sum + metricCount(row[1], 'YouTube Search view'), 0);
  const matched = details.filter((row) => Array.isArray(row) && isGoogleExternalReferrer(row[0]));
  const googleViews = matched.reduce((sum, row) => sum + metricCount(row[1], 'Google referral view'), 0);
  const capped = details.length >= maxDetailRows;
  return {
    youtubeSearchViews,
    googleSearchReferralViews: matched.length || !capped ? googleViews : null,
    googleSearchReferralComplete: !capped,
    googleSearchDetailRows: details.length
  };
}
module.exports = { youtubeSearchComparisonWindows, isGoogleExternalReferrer,
  hasYoutubeAnalyticsReadScopes, youtubeSearchReportQueries, summarizeYoutubeSearchPerformance };
