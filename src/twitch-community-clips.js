'use strict';

const crypto = require('crypto');

const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 60;
const MAX_COMMUNITY_CLIPS_PER_STREAM = 20;
const CLIP_TITLE_LIMIT = 100;

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustViewSignals(clips) {
  const values = clips.map((clip) => Math.log1p(Math.max(0, Number(clip.view_count) || 0)));
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const scale = Math.max(1.4826 * mad, 0.25);
  return values.map((value) => Math.max(-3, Math.min(3, (value - center) / scale)));
}

function communityClipScore(clip, robustViewZ, now) {
  const created = Date.parse(clip.created_at || '');
  const ageMinutes = Math.max(0, (now - created) / 60000);
  const engagement = 1 / (1 + Math.exp(-robustViewZ));
  const recency = Math.exp(-Math.LN2 * ageMinutes / 30);
  return 0.65 * engagement + 0.35 * recency;
}

function isValidCommunityClip(clip, {
  broadcasterId,
  streamStartedAt,
  now = Date.now(),
  vodId = null
} = {}) {
  if (!clip || typeof clip !== 'object') return false;
  const id = String(clip.id || '');
  const clipBroadcaster = String(clip.broadcaster_id || '');
  const gameId = String(clip.game_id || '');
  const duration = Number(clip.duration);
  const created = Date.parse(clip.created_at || '');
  const started = Date.parse(streamStartedAt || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^\d+$/.test(String(broadcasterId || '')) ||
      clipBroadcaster !== String(broadcasterId) || !/^\d+$/.test(gameId) ||
      !Number.isFinite(duration) || duration < MIN_CLIP_SECONDS || duration > MAX_CLIP_SECONDS ||
      !Number.isFinite(created) || !Number.isFinite(started) ||
      created < started - 5 * 60 * 1000 || created > now + 2 * 60 * 1000) return false;
  if (vodId && clip.video_id && String(clip.video_id) !== String(vodId)) return false;
  return true;
}

function buildCommunityClipDrafts(clips, {
  broadcasterId,
  streamId,
  streamStartedAt,
  streamTitle = '',
  sourceChannel = 'Twitch channel',
  gameId = null,
  gameName = '',
  vodId = null,
  editorId = broadcasterId,
  existingDrafts = [],
  maxPerStream = MAX_COMMUNITY_CLIPS_PER_STREAM,
  maxNew = MAX_COMMUNITY_CLIPS_PER_STREAM,
  now = Date.now(),
  idFactory = () => crypto.randomUUID()
} = {}) {
  if (!Array.isArray(clips) || !Array.isArray(existingDrafts)) return [];
  const perStream = Math.max(0, Math.floor(Number(maxPerStream) || 0));
  const newLimit = Math.max(0, Math.floor(Number(maxNew) || 0));
  const existingClipIds = new Set(existingDrafts.map((draft) => String(draft?.twitchClipId || '')));
  const existingForStream = existingDrafts.filter((draft) =>
    draft?.discoverySource === 'twitch_community_clip' && String(draft.streamId || '') === String(streamId));
  const capacity = Math.max(0, Math.min(perStream - existingForStream.length, newLimit));
  if (!capacity || !/^\d+$/.test(String(streamId || ''))) return [];

  const unique = new Map();
  for (const clip of clips) {
    const id = String(clip?.id || '');
    if (existingClipIds.has(id) || unique.has(id)) continue;
    if (gameId && String(clip?.game_id || '') !== String(gameId)) continue;
    if (!isValidCommunityClip(clip, { broadcasterId, streamStartedAt, now, vodId })) continue;
    unique.set(id, clip);
  }
  const candidates = [...unique.values()];
  const signals = robustViewSignals(candidates);
  return candidates.map((clip, index) => ({
    clip,
    score: communityClipScore(clip, signals[index], now)
  })).sort((left, right) =>
    right.score - left.score || Date.parse(right.clip.created_at) - Date.parse(left.clip.created_at) ||
    String(left.clip.id).localeCompare(String(right.clip.id)))
    .slice(0, capacity)
    .map(({ clip, score }) => {
      const duration = Math.round(Number(clip.duration) * 10) / 10;
      const vodOffset = Number.isFinite(Number(clip.vod_offset)) && Number(clip.vod_offset) >= duration
        ? Number(clip.vod_offset) : null;
      const resolvedVodId = clip.video_id ? String(clip.video_id) : vodId ? String(vodId) : null;
      const title = communityClipTitle({
        clipTitle: clip.title,
        gameName: clip.game_name || gameName,
        streamTitle
      });
      return {
        id: idFactory(),
        sourceType: 'twitch_vod',
        discoverySource: 'twitch_community_clip',
        sourcePlatform: 'Twitch',
        sourceChannel: clean(sourceChannel, 50) || 'Twitch channel',
        streamId: String(streamId),
        vodId: resolvedVodId,
        gameId: String(clip.game_id),
        gameName: clean(clip.game_name || gameName, 80),
        streamTitle: clean(streamTitle, 100),
        startSeconds: vodOffset === null ? 0 : Math.max(0, vodOffset - duration),
        endSeconds: vodOffset === null ? duration : vodOffset,
        duration,
        title,
        reason: 'Twitch community clip queued for gameplay verification.',
        twitchClipId: String(clip.id),
        twitchBroadcasterId: String(broadcasterId),
        twitchEditorId: String(editorId),
        twitchUrl: `https://clips.twitch.tv/${clip.id}`,
        twitchClipTitle: clean(clip.title, 200),
        twitchClipCreatedAt: new Date(Date.parse(clip.created_at)).toISOString(),
        twitchClipViewCount: Math.max(0, Math.floor(Number(clip.view_count) || 0)),
        communityClipScore: Number(score.toFixed(6)),
        visualGameplayVerification: null,
        status: 'clip_queued',
        productionState: 'queued',
        publicationStatus: 'pending',
        autoPublishEligible: false,
        clipAttemptCount: 0,
        createdAt: new Date(now).toISOString()
      };
    });
}

function communityClipTitle({ clipTitle, gameName, streamTitle }) {
  const game = clean(gameName, 40);
  const stream = clean(streamTitle, 50);
  let base = clean(clipTitle, 80);
  if (!base || /^(test|clip|untitled|default)$/i.test(base)) {
    base = game ? `${game} gameplay highlight` : `${stream || 'Live'} gameplay highlight`;
  }
  const suffix = game && !base.toLowerCase().includes(game.toLowerCase()) ? ` | ${game}` : '';
  const withSuffix = `${base}${suffix} #Shorts`;
  return clean(withSuffix, CLIP_TITLE_LIMIT) || 'Gaming highlight #Shorts';
}

function clipRetryDelayMs(attempt, jobId = '') {
  const count = Math.max(1, Math.min(12, Math.floor(Number(attempt) || 1)));
  const exponential = Math.min(6 * 60 * 60 * 1000, 15 * 1000 * (2 ** (count - 1)));
  let hash = 2166136261;
  for (const char of `${jobId}:${count}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const jitter = 0.8 + (hash / 0xffffffff) * 0.4;
  return Math.min(6 * 60 * 60 * 1000, Math.round(exponential * jitter));
}

function isRetryableCommunityClipError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if ([408, 425, 429].includes(status) || status >= 500 && status <= 599) return true;
  const code = String(error?.code || '').toUpperCase();
  if (/^(ABORT_ERR|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) return true;
  const message = String(error?.message || '').toLowerCase();
  if (/not ready|temporarily unavailable|timeout|timed out|fetch failed|network error/.test(message)) return true;
  return false;
}

module.exports = {
  MIN_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  MAX_COMMUNITY_CLIPS_PER_STREAM,
  isValidCommunityClip,
  communityClipScore,
  buildCommunityClipDrafts,
  clipRetryDelayMs,
  isRetryableCommunityClipError
};
