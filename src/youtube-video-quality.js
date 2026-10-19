'use strict';

const MARKET_RETENTION_FLOOR = 0.5;
const MARKET_RETENTION_CEILING = 0.75;
const CHANNEL_HISTORY_SIZE = 10;
const CHANNEL_MINIMUM_VIEWS = 100;
const MINIMUM_RETENTION_POINTS = 10;
const MAD_NORMAL_SCALE = 1.4826;
const ROBUST_CEILING_SIGMAS = 1.5;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function youtubeVideoQualityQueries(videoId, startDate, endDate) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || '')) ||
      !validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error('A video ID and valid YouTube Analytics date range are required');
  }
  const common = { ids: 'channel==MINE', startDate, endDate, filters: 'video==' + videoId };
  return [
    { ...common, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage' },
    { ...common, dimensions: 'elapsedVideoTimeRatio', metrics: 'relativeRetentionPerformance' }
  ];
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function interpolate(points, x) {
  if (!points.length || x < points[0].x || x > points[points.length - 1].x) return null;
  for (let index = 1; index < points.length; index += 1) {
    if (x > points[index].x) continue;
    const left = points[index - 1];
    const right = points[index];
    if (right.x === left.x) return right.y;
    const fraction = (x - left.x) / (right.x - left.x);
    return left.y * (1 - fraction) + right.y * fraction;
  }
  return points.at(-1).y;
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === '' ||
      typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeRelativeRetention(rows, durationSeconds = 12 * 60) {
  const duration = Number(durationSeconds);
  const byPosition = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const x = finiteMetric(row[0]);
    const y = finiteMetric(row[1]);
    if (x === null || x < 0 || x > 1 || y === null || y < 0 || y > 1) continue;
    const values = byPosition.get(x) || [];
    values.push(y);
    byPosition.set(x, values);
  }
  const points = [...byPosition.entries()].map(([x, values]) => ({
    x, y: values.reduce((sum, value) => sum + value, 0) / values.length
  })).sort((left, right) => left.x - right.x);
  if (!Number.isFinite(duration) || duration <= 0 || points.length < MINIMUM_RETENTION_POINTS ||
      points[0].x > 0.05 || points.at(-1).x < 0.95) {
    return { available: false, pointCount: points.length, score: null, introScore: null };
  }
  const coveredSpan = points.at(-1).x - points[0].x;
  if (coveredSpan <= 0) return { available: false, pointCount: points.length, score: null, introScore: null };
  let area = 0;
  for (let index = 1; index < points.length; index += 1) {
    const width = points[index].x - points[index - 1].x;
    area += width * (points[index].y + points[index - 1].y) / 2;
  }
  const score = Math.max(0, Math.min(1, area / coveredSpan));
  const introScore = interpolate(points, Math.min(1, 30 / duration));
  return {
    available: introScore !== null,
    pointCount: points.length,
    score: Number(score.toFixed(4)),
    introScore: introScore === null ? null : Number(introScore.toFixed(4))
  };
}

function summarizeChannelBand(history, currentAverageViewPercentage) {
  const prior = (Array.isArray(history) ? history : [])
    .filter((item) => finiteMetric(item?.averageViewPercentage) !== null &&
      finiteMetric(item.averageViewPercentage) >= 0 && finiteMetric(item.views) >= CHANNEL_MINIMUM_VIEWS)
    .sort((left, right) => Date.parse(left.publishedAt || '') - Date.parse(right.publishedAt || ''))
    .slice(-CHANNEL_HISTORY_SIZE);
  const values = prior.map((item) => Number(item.averageViewPercentage));
  const sampleSize = values.length;
  if (sampleSize < CHANNEL_HISTORY_SIZE) {
    return {
      calibrated: false,
      sampleSize,
      requiredSampleSize: CHANNEL_HISTORY_SIZE,
      floor: null,
      ceiling: null,
      status: 'warming_up'
    };
  }

  const floor = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  const mad = quantile(values.map((value) => Math.abs(value - floor)), 0.5);
  const robustCeiling = mad > 0 ? floor + ROBUST_CEILING_SIGMAS * MAD_NORMAL_SCALE * mad : p90;
  const ceiling = Math.max(floor, Math.min(p90, robustCeiling));
  const current = finiteMetric(currentAverageViewPercentage);
  const status = currentAverageViewPercentage === null || currentAverageViewPercentage === undefined ||
      current === null ? 'unavailable'
    : current < floor ? 'below_floor'
      : current > ceiling ? 'above_ceiling' : 'within_band';
  return {
    calibrated: true,
    sampleSize,
    requiredSampleSize: CHANNEL_HISTORY_SIZE,
    floor: Number(floor.toFixed(2)),
    ceiling: Number(ceiling.toFixed(2)),
    medianAbsoluteDeviation: Number(mad.toFixed(2)),
    status
  };
}

function summarizeYoutubeVideoQuality(summaryRows, retentionRows, {
  durationSeconds = 12 * 60,
  history = []
} = {}) {
  const row = Array.isArray(summaryRows) && Array.isArray(summaryRows[0]) ? summaryRows[0] : [];
  const viewsValue = finiteMetric(row[0]);
  const watchedMinutesValue = finiteMetric(row[1]);
  const averageViewDurationValue = finiteMetric(row[2]);
  const averageViewPercentageValue = finiteMetric(row[3]);
  const views = viewsValue !== null && viewsValue >= 0 ? Math.floor(viewsValue) : 0;
  const estimatedMinutesWatched = watchedMinutesValue !== null && watchedMinutesValue >= 0
    ? Number(watchedMinutesValue.toFixed(2)) : null;
  const averageViewDurationSeconds = averageViewDurationValue !== null && averageViewDurationValue >= 0
    ? Number(averageViewDurationValue.toFixed(2)) : null;
  const averageViewPercentage = averageViewPercentageValue !== null && averageViewPercentageValue >= 0
    ? Number(averageViewPercentageValue.toFixed(2)) : null;
  const relativeRetention = summarizeRelativeRetention(retentionRows, durationSeconds);
  const channelBand = summarizeChannelBand(history, averageViewPercentage);
  const marketStatus = !relativeRetention.available ? 'insufficient_retention_data'
    : relativeRetention.score < MARKET_RETENTION_FLOOR ? 'below_market_floor'
      : relativeRetention.score >= MARKET_RETENTION_CEILING ? 'above_market_ceiling' : 'within_market_band';
  const status = views < CHANNEL_MINIMUM_VIEWS ? 'low_sample'
    : !relativeRetention.available ? 'insufficient_retention_data'
      : channelBand.calibrated && channelBand.status !== 'unavailable' ? channelBand.status : marketStatus;

  return {
    status,
    assessedViews: views,
    estimatedMinutesWatched,
    averageViewDurationSeconds,
    averageViewPercentage,
    relativeRetentionScore: relativeRetention.score,
    introRelativeRetentionScore: relativeRetention.introScore,
    retentionPointCount: relativeRetention.pointCount,
    marketFloor: MARKET_RETENTION_FLOOR,
    marketCeiling: MARKET_RETENTION_CEILING,
    marketStatus,
    channelBand
  };
}

module.exports = {
  MARKET_RETENTION_FLOOR,
  MARKET_RETENTION_CEILING,
  CHANNEL_HISTORY_SIZE,
  CHANNEL_MINIMUM_VIEWS,
  youtubeVideoQualityQueries,
  summarizeRelativeRetention,
  summarizeChannelBand,
  summarizeYoutubeVideoQuality
};
