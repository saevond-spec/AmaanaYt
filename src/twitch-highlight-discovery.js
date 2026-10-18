'use strict';

const crypto = require('crypto');
const { select15MinuteGameplayHighlights, TARGET_HIGHLIGHT_DURATION_SECONDS,
  MAX_HIGHLIGHT_SEGMENTS } = require('./highlight-selection');

const DEFAULT_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const RECENT_VOD_LIMIT = 20;
const MAX_AUTO_HIGHLIGHTS = MAX_HIGHLIGHT_SEGMENTS;
const MAX_AUTO_SHORTS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function selectCommunityHighlights(clips, vod, { limit = MAX_AUTO_HIGHLIGHTS,
  targetDurationSeconds = TARGET_HIGHLIGHT_DURATION_SECONDS } = {}) {
  return select15MinuteGameplayHighlights(clips, vod, {
    targetDurationSeconds,
    maxSegments: limit
  });
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
  vodLimit = RECENT_VOD_LIMIT,
  targetDurationSeconds = TARGET_HIGHLIGHT_DURATION_SECONDS,
  visualGameplayVerificationAvailable = () => false
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
      if (!visualGameplayVerificationAvailable()) {
        await markScanned(requestedId);
        return { status: 'visual_gameplay_screening_disabled', vodId: requestedId,
          targetDurationSeconds };
      }

      const clips = await twitch.listClipsForVod(vod);
      const selected = selectCommunityHighlights(clips, vod, { targetDurationSeconds });
      if (!selected.highlights.length) {
        await markScanned(requestedId);
        return {
          status: selected.rejectionReason === 'no_game_category_clips'
            ? 'no_gameplay_candidates' : 'insufficient_gameplay_duration',
          vodId: requestedId, clipsChecked: Array.isArray(clips) ? clips.length : 0,
          availableGameplaySeconds: selected.availableGameplaySeconds || 0,
          targetDurationSeconds: selected.targetDurationSeconds
        };
      }

      const shortCandidateIndexes = selected.evidence.map((item, index) => ({
        index, score: Number(item && item.selectionScore) || 0
      })).sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, Math.min(MAX_AUTO_SHORTS, selected.highlights.length))
        .map((item) => item.index);

      const streamTitle = clean(vod.title, 100);
      const channel = clean(vod.user_name || vod.user_login, 50) || 'Twitch channel';
      const batch = {
        id: idFactory(),
        sourceType: 'twitch_highlight_batch',
        discoverySource: 'twitch_clips_api',
        sourceChannel: channel,
        vodId: requestedId,
        vodDurationSeconds: selected.vodDurationSeconds,
        targetHighlightDurationSeconds: selected.targetDurationSeconds,
        streamTitle,
        title: clean(`${streamTitle || 'Twitch livestream'} | Best moments`, 100),
        highlights: selected.highlights,
        shortCandidateIndexes,
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
        logger.info(`Amaana selected ${selected.highlights.length} game-category moments for a 15-minute highlight from VOD ${requestedId}`);
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
      vodsSeen: 0, scanned: 0, queued: 0, noCandidates: 0, insufficientGameplayDuration: 0,
      visualScreeningUnavailable: 0,
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
          else if (scan.status === 'no_gameplay_candidates') result.noCandidates += 1;
          else if (scan.status === 'insufficient_gameplay_duration') result.insufficientGameplayDuration += 1;
          else if (scan.status === 'visual_gameplay_screening_disabled') result.visualScreeningUnavailable += 1;
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
