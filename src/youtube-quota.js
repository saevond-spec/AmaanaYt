'use strict';

const TIME_ZONE = 'America/Los_Angeles';
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function dateParts(timestamp) {
  const value = Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(value.year), month: Number(value.month), day: Number(value.day),
    hour: Number(value.hour), minute: Number(value.minute), second: Number(value.second)
  };
}

function youtubeQuotaDate(timestamp = Date.now()) {
  const { year, month, day } = dateParts(timestamp);
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'),
    String(day).padStart(2, '0')].join('-');
}

function zoneOffset(timestamp) {
  const parts = dateParts(timestamp);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second);
  return zonedAsUtc - Math.floor(timestamp / 1000) * 1000;
}

function nextYoutubeQuotaReset(timestamp = Date.now()) {
  const { year, month, day } = dateParts(timestamp);
  const nextLocalMidnightAsUtc = Date.UTC(year, month - 1, day + 1);
  const firstEstimate = nextLocalMidnightAsUtc - zoneOffset(timestamp);
  // Recalculate at the estimated reset so a daylight-saving transition is handled.
  return nextLocalMidnightAsUtc - zoneOffset(firstEstimate);
}

function youtubeErrorText(error) {
  const apiError = error?.response?.data?.error || {};
  return [apiError.status, apiError.message, ...(apiError.errors || []).map((item) => item?.reason),
    error?.message].filter(Boolean).join(' ').toLowerCase();
}

function isYouTubeDailyQuotaError(error) {
  return /quotaexceeded|dailylimitexceeded|daily quota/.test(youtubeErrorText(error));
}

function isYouTubeQuotaError(error) {
  return /quotaexceeded|dailylimitexceeded|daily quota|ratelimitexceeded|userratelimitexceeded|resourceexhausted/.test(
    youtubeErrorText(error));
}

function youtubeQuotaRetryAt(error, timestamp = Date.now()) {
  return isYouTubeDailyQuotaError(error)
    ? nextYoutubeQuotaReset(timestamp)
    : isYouTubeQuotaError(error) ? timestamp + 5 * 60 * 1000 : null;
}

module.exports = { youtubeQuotaDate, nextYoutubeQuotaReset,
  isYouTubeDailyQuotaError, isYouTubeQuotaError, youtubeQuotaRetryAt };
