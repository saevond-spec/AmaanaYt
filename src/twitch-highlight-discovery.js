'use strict';

const crypto = require('crypto');
const { parseTwitchDuration, validateHighlightMoments } = require('./highlight-validation');

const DEFAULT_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const RECENT_VOD_LIMIT = 20;
const MAX_AUTO_HIGHLIGHTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function overlaps(left, right) {
  const shared = Math.max(0, Math.min(left.endSeconds, right.endSeconds) -
    Math.max(left.startSeconds, right.startSeconds));
  return shared / Math.min(left.duration, right.duration) >= 0.6 ||
    Math.abs(left.endSeconds - right.endSeconds) < 3;
}

function selectCommunityHighlights(clips, vod, { limit = MAX_AUTO_HIGHLIGHTS } = {}) {
  const vodId = String(vod && vod.id || '');
  const broadcasterId = String(vod && vod.user_id || '');
  const vodDurationSeconds = parseTwitchDuration(vod && vod.duration);
  const maximum = Math.max(1, Math.min(MAX_AUTO_HIGHLIGHTS,
    Math.floor(Number(limit) || MAX_AUTO_HIGHLIGHTS)));
  const candidates = (Array.isArray(clips) ? clips : []).flatMap((clip) => {
    if (!clip || !clip.id || String(clip.video_id || '') !== vodId ||
        broadcasterId && String(clip.broadcaster_id || '') !== broadcasterId) return [];
    const startSeconds = clip.vod_offset === null || clip.vod_offset === undefined || clip.vod_offset === ''
      ? NaN : Number(clip.vod_offset);
    const duration = clip.duration === null || clip.duration === undefined || clip.duration === ''
      ? NaN : Number(clip.duration);
    const endSeconds = startSeconds + duration;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(duration) || startSeconds < 0 ||
        duration < 5 || duration > 60 || endSeconds > vodDurationSeconds + 0.25) return [];
    const clipTitle = clean(clip.title, 100) || 'Twitch community clip';
    const viewCount = positiveNumber(clip.view_count);
    const createdAt = Date.parse(clip.created_at || '') || 0;
    const moment = {
      startSeconds: Number(startSeconds.toFixed(1)),
      endSeconds: Number(endSeconds.toFixed(1)),
      duration: Number(duration.toFixed(1)),
      title: clipTitle,
      reason: `Twitch community clip (${viewCount} ${viewCount === 1 ? 'view' : 'views'}): ${clipTitle}`,
      score: null
    };
    return [{
      clipId: String(clip.id), viewCount, createdAt, moment,
      evidence: {
        clipId: String(clip.id), title: clipTitle, viewCount,
        createdAt: clip.created_at || null,
        startSeconds: moment.startSeconds, duration: moment.duration
      }
    }];
  });

  candidates.sort((left, right) => right.viewCount - left.viewCount ||
    right.createdAt - left.createdAt || left.clipId.localeCompare(right.clipId));

  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((current) => overlaps(current.moment, candidate.moment))) continue;
    selected.push(candidate);
    if (selected.length >= maximum) break;
  }

  if (!selected.length) return { vodDurationSeconds, highlights: [], evidence: [] };

  const highlights = validateHighlightMoments(selected.map((candidate) => candidate.moment), vodDurationSeconds);
  const evidenceByMoment = new Map(selected.map((candidate) => [
    `${candidate.moment.startSeconds}:${candidate.moment.duration}`, candidate.evidence
  ]));
  return {
    vodDurationSeconds,
    highlights,
    evidence: highlights.map((moment) => evidenceByMoment.get(`${moment.startSeconds}:${moment.duration}`))
      .filter(Boolean)
  };
}

function scanIntervalForVod(vod, now) {
  const createdAt = Date.parse(vod && vod.created_at || '');
  if (!Number.isFinite(createdAt)) return 6 * 60 * 60 * 1000;
  const age = Math.max(0, now - createdAt);
  if (age <= DAY_MS) return 15 * 60 * 1000;
  if (age <= 7 * DAY_MS) return 2 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function createTwitchHighlightDiscovery({
  twitch,
  store,
  enqueueBatch,
  logger = console,
  idFactory = () => crypto.randomUUID(),
  now = () => Date.now(),
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  vodLimit = RECENT_VOD_LIMIT
}) {
  if (!twitch || !store || typeof enqueueBatch !== 'function') {
    throw new Error('Twitch highlight discovery requires Twitch, storage, and a batch queue');
  }

  let stateCache;
  let running = false;
  let timer = null;
  let lastRunAt = null;
  let lastRunResult = null;
  let lastRunError = null;
  const inFlightVodIds = new Set();

  async function getState() {
    if (stateCache) return stateCache;
    const persisted = typeof store.getTwitchHighlightDiscoveryState === 'function'
      ? await store.getTwitchHighlightDiscoveryState() : null;
    stateCache = persisted && typeof persisted === 'object' ? persisted : {};
    if (!stateCache.lastScannedAt || typeof stateCache.lastScannedAt !== 'object') {
      stateCache.lastScannedAt = {};
    }
    return stateCache;
  }

  async function markScanned(vodId) {
    const state = await getState();
    state.lastScannedAt[String(vodId)] = new Date(now()).toISOString();
    const entries = Object.entries(state.lastScannedAt)
      .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1])).slice(0, 100);
    state.lastScannedAt = Object.fromEntries(entries);
    state.updatedAt = new Date(now()).toISOString();
    if (typeof store.saveTwitchHighlightDiscoveryState === 'function') {
      await store.saveTwitchHighlightDiscoveryState(state);
    }
  }

  async function scanVod(vodOrId, { drafts: knownDrafts } = {}) {
    const requestedId = String(typeof vodOrId === 'object' && vodOrId ? vodOrId.id : vodOrId || '');
    if (!/^\d+$/.test(requestedId)) throw new Error('A numeric Twitch VOD ID is required');
    if (inFlightVodIds.has(requestedId)) return { status: 'already_scanning', vodId: requestedId };
    inFlightVodIds.add(requestedId);
    try {
      const vod = typeof vodOrId === 'object' && vodOrId ? vodOrId : await twitch.getVod(requestedId);
      if (String(vod.id || '') !== requestedId || vod.type !== 'archive') {
        throw new Error('Twitch returned a different video or a non-archive VOD');
      }
      const drafts = knownDrafts || await store.listDrafts();
      const existing = drafts.find((draft) => draft && draft.sourceType === 'twitch_highlight_batch' &&
        String(draft.vodId) === requestedId);
      if (existing) return { status: 'already_exists', vodId: requestedId, batch: existing };

      const clips = await twitch.listClipsForVod(vod);
      const selected = selectCommunityHighlights(clips, vod);
      if (!selected.highlights.length) {
        await markScanned(requestedId);
        return { status: 'no_candidates', vodId: requestedId, clipsChecked: Array.isArray(clips) ? clips.length : 0 };
      }

      const streamTitle = clean(vod.title, 100);
      const channel = clean(vod.user_name || vod.user_login, 50) || 'Twitch channel';
      const batch = {
        id: idFactory(),
        sourceType: 'twitch_highlight_batch',
        discoverySource: 'twitch_clips_api',
        sourceChannel: channel,
        vodId: requestedId,
        vodDurationSeconds: selected.vodDurationSeconds,
        streamTitle,
        title: clean(`${streamTitle || 'Twitch livestream'} | Best moments`, 100),
        highlights: selected.highlights,
        sourceClipEvidence: selected.evidence,
        candidateClipCount: Array.isArray(clips) ? clips.length : 0,
        pipelineVersion: 3,
        thumbnailStatus: 'pending',
        autoPublishEligible: true,
        publicationStatus: 'pending',
        status: 'clip_queued',
        createdAt: new Date(now()).toISOString()
      };
      const saved = await store.addDraft(batch);
      await markScanned(requestedId);
      enqueueBatch(saved.id);
      if (logger && typeof logger.info === 'function') {
        logger.info(`Amaana discovered ${selected.highlights.length} Twitch highlight moments for VOD ${requestedId}`);
      }
      return { status: 'queued', vodId: requestedId, batch: saved, clipsChecked: batch.candidateClipCount };
    } finally {
      inFlightVodIds.delete(requestedId);
    }
  }

  async function run() {
    if (running) return { skipped: 'already_running' };
    running = true;
    const result = {
      vodsSeen: 0, scanned: 0, queued: 0, noCandidates: 0,
      alreadyExists: 0, throttled: 0, errors: 0
    };
    lastRunError = null;
    try {
      if (typeof twitch.isConnected === 'function' && !await twitch.isConnected()) {
        result.notConnected = true;
        lastRunAt = new Date(now()).toISOString();
        lastRunResult = result;
        return result;
      }
      const vods = await twitch.listRecentArchivedVods({ first: vodLimit });
      const drafts = await store.listDrafts();
      const state = await getState();
      const timestamp = now();
      result.vodsSeen = Array.isArray(vods) ? vods.length : 0;
      for (const vod of Array.isArray(vods) ? vods : []) {
        const vodId = String(vod && vod.id || '');
        if (!/^\d+$/.test(vodId) || vod.type !== 'archive') continue;
        const existing = drafts.find((draft) => draft && draft.sourceType === 'twitch_highlight_batch' &&
          String(draft.vodId) === vodId);
        if (existing) {
          result.alreadyExists += 1;
          continue;
        }
        const lastScannedAt = Date.parse(state.lastScannedAt[vodId] || '');
        if (Number.isFinite(lastScannedAt) && timestamp - lastScannedAt < scanIntervalForVod(vod, timestamp)) {
          result.throttled += 1;
          continue;
        }
        result.scanned += 1;
        try {
          const scan = await scanVod(vod, { drafts });
          if (scan.status === 'queued') result.queued += 1;
          else if (scan.status === 'no_candidates') result.noCandidates += 1;
          else if (scan.status === 'already_exists') result.alreadyExists += 1;
        } catch (error) {
          result.errors += 1;
          if (logger && typeof logger.error === 'function') {
            logger.error(`Amaana Twitch VOD scan failed for ${vodId}: ${error.message}`);
          }
        }
      }
      lastRunAt = new Date(timestamp).toISOString();
      lastRunResult = result;
      return result;
    } catch (error) {
      lastRunAt = new Date(now()).toISOString();
      lastRunError = error.message;
      lastRunResult = result;
      if (logger && typeof logger.error === 'function') logger.error(`Amaana Twitch highlight scan failed: ${error.message}`);
      return result;
    } finally {
      running = false;
    }
  }

  function start(intervalMs = scanIntervalMs) {
    if (timer) return timer;
    timer = setInterval(() => { void run(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void run();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function status() {
    return { running, lastRunAt, lastRunResult, lastRunError };
  }

  return { run, scanVod, start, stop, status };
}

module.exports = {
  createTwitchHighlightDiscovery,
  selectCommunityHighlights,
  scanIntervalForVod,
  DEFAULT_SCAN_INTERVAL_MS,
  RECENT_VOD_LIMIT,
  MAX_AUTO_HIGHLIGHTS
};
