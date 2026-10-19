'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { select15MinuteGameplayHighlights, TARGET_HIGHLIGHT_DURATION_SECONDS,
  MAX_HIGHLIGHT_SEGMENTS } = require('./highlight-selection');
const { parseTwitchDuration } = require('./highlight-validation');
const { buildCommunityClipDrafts } = require('./twitch-community-clips');
const { isPlaceholderTestTitle } = require('./gameplay-intake-guard');

const DEFAULT_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LIVE_SCAN_INTERVAL_MS = 60 * 1000;
const DEFAULT_LIVE_CAPTURE_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_LIVE_CAPTURE_DURATION_SECONDS = 60;
const DEFAULT_LIVE_CAPTURE_BUFFER_SECONDS = 90;
const LIVE_SHORT_CANDIDATE_GROUP_SIZE = 5;
const MAX_LIVE_SHORTS_PER_STREAM = 20;
const RECENT_VOD_LIMIT = 20;
const MAX_AUTO_HIGHLIGHTS = MAX_HIGHLIGHT_SEGMENTS;
const MAX_AUTO_SHORTS = 2;
const MAX_LIVE_CANDIDATES = 160;
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
  enqueueClip = () => {},
  logger = console,
  idFactory = () => crypto.randomUUID(),
  now = () => Date.now(),
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  liveScanIntervalMs = DEFAULT_LIVE_SCAN_INTERVAL_MS,
  liveCaptureIntervalMs = DEFAULT_LIVE_CAPTURE_INTERVAL_MS,
  liveCaptureDurationSeconds = DEFAULT_LIVE_CAPTURE_DURATION_SECONDS,
  liveCaptureBufferSeconds = DEFAULT_LIVE_CAPTURE_BUFFER_SECONDS,
  vodLimit = RECENT_VOD_LIMIT,
  targetDurationSeconds = TARGET_HIGHLIGHT_DURATION_SECONDS,
  video,
  visualGameplayVerificationAvailable = () => false
}) {
  if (!twitch || !store || typeof enqueueBatch !== 'function') {
    throw new Error('Twitch highlight discovery requires Twitch, storage, and a batch queue');
  }

  let stateCache;
  let running = false;
  let liveRunning = false;
  let timer = null;
  let liveTimer = null;
  let lastRunAt = null;
  let lastRunResult = null;
  let lastRunError = null;
  let lastLiveRunAt = null;
  let lastLiveRunResult = null;
  let lastLiveRunError = null;
  let stateSavePromise = Promise.resolve();
  const inFlightVodIds = new Set();

  async function getState() {
    if (stateCache) return stateCache;
    const persisted = typeof store.getTwitchHighlightDiscoveryState === 'function'
      ? await store.getTwitchHighlightDiscoveryState() : null;
    stateCache = persisted && typeof persisted === 'object' ? persisted : {};
    if (!stateCache.lastScannedAt || typeof stateCache.lastScannedAt !== 'object') {
      stateCache.lastScannedAt = {};
    }
    if (!stateCache.liveSessions || typeof stateCache.liveSessions !== 'object' ||
        Array.isArray(stateCache.liveSessions)) stateCache.liveSessions = {};
    return stateCache;
  }

  async function saveState() {
    const state = await getState();
    state.updatedAt = new Date(now()).toISOString();
    if (typeof store.saveTwitchHighlightDiscoveryState !== 'function') return;
    const snapshot = JSON.parse(JSON.stringify(state));
    stateSavePromise = stateSavePromise.catch(() => {}).then(() =>
      store.saveTwitchHighlightDiscoveryState(snapshot));
    await stateSavePromise;
  }

  async function markScanned(vodId) {
    const state = await getState();
    state.lastScannedAt[String(vodId)] = new Date(now()).toISOString();
    const entries = Object.entries(state.lastScannedAt)
      .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1])).slice(0, 100);
    state.lastScannedAt = Object.fromEntries(entries);
    await saveState();
  }

  async function queueCommunityClips(clips, context, result, knownDrafts) {
    if (!Array.isArray(clips) || !clips.length) return 0;
    const drafts = Array.isArray(knownDrafts) ? knownDrafts : await store.listDrafts();
    const queued = buildCommunityClipDrafts(clips, {
      ...context,
      existingDrafts: drafts,
      now: now(),
      idFactory
    });
    let count = 0;
    for (const draft of queued) {
      const saved = await store.addDraft(draft);
      drafts.push(saved);
      enqueueClip(saved.id);
      count += 1;
      if (logger && typeof logger.info === 'function') {
        logger.info('Amaana queued Twitch community clip ' + draft.twitchClipId + ' for gameplay screening');
      }
    }
    if (result) {
      result.communityClipsChecked = (Number(result.communityClipsChecked) || 0) + clips.length;
      result.communityClipsQueued = (Number(result.communityClipsQueued) || 0) + count;
    }
    return count;
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
      if (isPlaceholderTestTitle(vod.title)) {
        await markScanned(requestedId);
        return { status: 'test_stream_skipped', vodId: requestedId,
          streamTitle: clean(vod.title, 100), communityClipsQueued: 0, targetDurationSeconds };
      }
      const drafts = knownDrafts || await store.listDrafts();
      const existing = drafts.find((draft) => draft && draft.sourceType === 'twitch_highlight_batch' &&
        String(draft.vodId) === requestedId &&
        Number(draft.targetHighlightDurationSeconds) === Number(targetDurationSeconds));
      if (existing) return { status: 'already_exists', vodId: requestedId, batch: existing };
      const supersededBatch = drafts.find((draft) => draft && draft.sourceType === 'twitch_highlight_batch' &&
        String(draft.vodId) === requestedId &&
        Number(draft.targetHighlightDurationSeconds) !== Number(targetDurationSeconds));
      if (!visualGameplayVerificationAvailable()) {
        await markScanned(requestedId);
        return { status: 'visual_gameplay_screening_disabled', vodId: requestedId,
          targetDurationSeconds };
      }

      const clips = await twitch.listClipsForVod(vod);
      const broadcasterId = String(vod.user_id || '');
      const communityClipsQueued = await queueCommunityClips(clips, {
        broadcasterId,
        editorId: broadcasterId,
        streamId: String(vod.stream_id || vod.id),
        streamStartedAt: vod.created_at,
        streamTitle: vod.title,
        sourceChannel: vod.user_name || vod.user_login,
        gameId: vod.game_id || null,
        gameName: vod.game_name || '',
        vodId: requestedId
      }, null, drafts);
      const selected = selectCommunityHighlights(clips, vod, { targetDurationSeconds });
      if (!selected.highlights.length) {
        await markScanned(requestedId);
        return {
          status: selected.rejectionReason === 'no_game_category_clips'
            ? 'no_gameplay_candidates'
            : selected.rejectionReason === 'insufficient_quality_gameplay_duration'
              ? 'insufficient_quality_gameplay' : 'insufficient_gameplay_duration',
          vodId: requestedId, clipsChecked: Array.isArray(clips) ? clips.length : 0,
          availableGameplaySeconds: selected.availableGameplaySeconds || 0,
          unfilteredGameplaySeconds: selected.unfilteredGameplaySeconds || 0,
          qualityCalibration: selected.qualityCalibration || null,
          communityClipsQueued,
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
        supersedesDraftId: supersededBatch?.id || null,
        streamTitle,
        title: clean(`${streamTitle || 'Twitch livestream'} | Best moments`, 100),
        highlights: selected.highlights,
        shortCandidateIndexes,
        sourceClipEvidence: selected.evidence,
        qualityCalibration: selected.qualityCalibration,
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
      return { status: 'queued', vodId: requestedId, batch: saved,
        clipsChecked: batch.candidateClipCount, communityClipsQueued };
    } finally {
      inFlightVodIds.delete(requestedId);
    }
  }

  async function queueReadyLiveBatches(vod, stream, session, result) {
    let drafts = await store.listDrafts();
    let queued = 0;
    while (queued < 2) {
      const liveClips = session.candidates.map((candidate) => ({
        id: candidate.clip.id,
        video_id: String(vod.id),
        broadcaster_id: String(stream.user_id),
        game_id: candidate.gameId,
        vod_offset: candidate.startSeconds,
        duration: candidate.duration,
        view_count: candidate.viewCount,
        title: candidate.title,
        created_at: candidate.createdAt
      }));
      const selected = selectCommunityHighlights(liveClips, vod, { targetDurationSeconds });
      result.availableGameplaySeconds = selected.availableGameplaySeconds || 0;
      if (!selected.highlights.length) break;

      const candidateById = new Map(session.candidates.map((candidate) =>
        [String(candidate.clip.id), candidate]));
      const selectedEvidence = selected.evidence;
      const selectedCandidates = selectedEvidence.map((item) =>
        candidateById.get(String(item.clipId))).filter(Boolean);
      if (selectedCandidates.length !== selected.highlights.length) break;

      const batchIndex = (Number(session.batchIndex) || 0) + 1;
      let batch = drafts.find((draft) => draft &&
        draft.sourceType === 'twitch_highlight_batch' &&
        draft.discoverySource === 'twitch_live_capture' &&
        String(draft.streamId) === String(stream.id) &&
        Number(draft.streamBatchIndex) === batchIndex);
      if (!batch) {
        const streamTitle = clean(stream.title, 100);
        const channel = clean(stream.user_name || stream.user_login, 50) || 'Twitch channel';
        batch = {
          id: idFactory(),
          sourceType: 'twitch_highlight_batch',
          discoverySource: 'twitch_live_capture',
          sourceChannel: channel,
          vodId: String(vod.id),
          streamId: String(stream.id),
          streamBatchIndex: batchIndex,
          streamStartedAt: stream.started_at || null,
          vodDurationSeconds: selected.vodDurationSeconds,
          targetHighlightDurationSeconds: selected.targetDurationSeconds,
          streamTitle,
          title: clean((streamTitle || 'Twitch livestream') + ' | Best moments', 100),
          highlights: selected.highlights,
          // Each fifth screened live capture is already staged as its own private Short.
          // Avoid uploading a duplicate set of Shorts from the later landscape montage.
          shortCandidateIndexes: [],
          sourceClipEvidence: selected.evidence,
          twitchClips: selectedCandidates.map((candidate) => candidate.clip),
          candidateClipCount: liveClips.length,
          pipelineVersion: 3,
          thumbnailStatus: 'pending',
          autoPublishEligible: true,
          publicationStatus: 'pending',
          status: 'clip_queued',
          createdAt: new Date(now()).toISOString()
        };
        batch = await store.addDraft(batch);
        drafts.push(batch);
      }

      const selectedIds = new Set(selectedCandidates.map((candidate) => String(candidate.clip.id)));
      session.candidates = session.candidates.filter((candidate) =>
        !selectedIds.has(String(candidate.clip.id)));
      session.batchIndex = batchIndex;
      session.lastBatchAt = new Date(now()).toISOString();
      session.lastBatchId = batch.id;
      await saveState();
      enqueueBatch(batch.id);
      queued += 1;
      result.batchesQueued += 1;
      result.lastBatchId = batch.id;
      result.status = 'queued';
      if (logger && typeof logger.info === 'function') {
        logger.info('Amaana queued live Twitch highlight batch ' + batch.id +
          ' for owner review after gameplay screening');
      }
      drafts = await store.listDrafts();
    }
    return queued;
  }

  async function queueReadyLiveShorts(stream, session, result, { flush = false } = {}) {
    let drafts = await store.listDrafts();
    if (!Array.isArray(session.shortCandidates)) session.shortCandidates = [];
    while ((flush || session.shortCandidates.length >= LIVE_SHORT_CANDIDATE_GROUP_SIZE) &&
        session.shortCandidates.length > 0 &&
        (Number(session.liveShortIndex) || 0) < MAX_LIVE_SHORTS_PER_STREAM) {
      const batchIndex = (Number(session.liveShortIndex) || 0) + 1;
      const groupSize = Math.min(LIVE_SHORT_CANDIDATE_GROUP_SIZE, session.shortCandidates.length);
      const group = session.shortCandidates.slice(0, groupSize);
      const score = (candidate) => {
        const visual = candidate.clip && candidate.clip.visualGameplayVerification || {};
        const activeRatio = Number(visual.totalFrames) > 0
          ? Number(visual.activeGameplayFrames) / Number(visual.totalFrames) : 0;
        return 0.6 * (Number(visual.confidence) || 0) + 0.4 * activeRatio;
      };
      const best = [...group].sort((left, right) =>
        score(right) - score(left) || Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
      const existing = drafts.find((draft) => draft &&
        draft.sourceType === 'twitch_vod' &&
        draft.discoverySource === 'twitch_live_capture' &&
        String(draft.streamId) === String(stream.id) &&
        Number(draft.liveShortIndex) === batchIndex);
      let draft = existing;
      if (!draft) {
        const clip = best.clip;
        const title = clean((session.streamTitle || 'Livestream') + ' | Live gameplay ' + batchIndex, 100);
        draft = await store.addDraft({
          id: idFactory(),
          sourceType: 'twitch_vod',
          discoverySource: 'twitch_live_capture',
          liveCapture: true,
          liveShortIndex: batchIndex,
          streamId: String(stream.id),
          vodId: String(session.vodId),
          sourceChannel: clean(stream.user_name || stream.user_login, 50),
          streamTitle: session.streamTitle || '',
          gameId: best.gameId,
          startSeconds: best.startSeconds,
          endSeconds: best.startSeconds + best.duration,
          duration: best.duration,
          title,
          reason: 'Visual gameplay verified from a live Twitch capture.',
          twitchClipId: clip.id,
          twitchBroadcasterId: clip.broadcasterId || String(stream.user_id),
          twitchEditorId: clip.editorId || String(stream.user_id),
          twitchUrl: 'https://clips.twitch.tv/' + clip.id,
          visualGameplayVerification: clip.visualGameplayVerification,
          status: 'clip_queued',
          productionState: 'queued',
          publicationStatus: 'pending',
          createdAt: new Date(now()).toISOString()
        });
        drafts.push(draft);
      }
      session.shortCandidates = session.shortCandidates.slice(groupSize);
      session.liveShortIndex = batchIndex;
      session.lastLiveShortId = draft.id;
      await saveState();
      enqueueClip(draft.id);
      result.liveShortsQueued = (Number(result.liveShortsQueued) || 0) + 1;
      result.lastLiveShortId = draft.id;
      if (logger && typeof logger.info === 'function') {
        logger.info('Amaana queued live Twitch Short ' + draft.id + ' for owner review');
      }
      drafts = await store.listDrafts();
    }
  }

  async function scanLiveBroadcast() {
    const result = {
      status: 'idle', live: false, captureAttempted: false, captureAccepted: false,
      candidatesVerified: 0, gameplayRejected: 0, batchesQueued: 0,
      availableGameplaySeconds: 0
    };
    if (typeof twitch.getLiveBroadcast !== 'function') {
      result.status = 'live_broadcast_lookup_unavailable';
      return result;
    }
    if (!visualGameplayVerificationAvailable()) {
      result.status = 'visual_gameplay_screening_disabled';
      return result;
    }
    if (!video || typeof video.verifyGameplay !== 'function' ||
        typeof video.inspectMedia !== 'function') {
      result.status = 'visual_gameplay_screening_unavailable';
      return result;
    }
    const broadcast = await twitch.getLiveBroadcast();
    if (!broadcast || !broadcast.stream) {
      const state = await getState();
      for (const session of Object.values(state.liveSessions)) {
        if (!session || !Array.isArray(session.shortCandidates) || !session.shortCandidates.length) continue;
        await queueReadyLiveShorts({
          id: session.streamId, user_id: session.streamUserId,
          user_name: session.sourceChannel, user_login: session.sourceChannel,
          title: session.streamTitle
        }, session, result, { flush: true });
      }
      await saveState();
      result.status = 'not_live';
      return result;
    }
    result.live = true;
    const stream = broadcast.stream;
    const vod = broadcast.vod;
    const streamId = String(stream.id || '');
    const userId = String(broadcast.user && broadcast.user.id || stream.user_id || '');
    if (!/^\d+$/.test(streamId) || !/^\d+$/.test(userId)) {
      result.status = 'invalid_live_broadcast';
      return result;
    }
    if (isPlaceholderTestTitle(stream.title)) {
      result.status = 'test_stream_skipped';
      result.streamTitle = clean(stream.title, 100);
      return result;
    }
    const timestamp = now();
    if (typeof twitch.listRecentLiveClips === 'function') {
      try {
        const clips = await twitch.listRecentLiveClips({
          startedAt: stream.started_at,
          endedAt: new Date(timestamp).toISOString()
        });
        await queueCommunityClips(clips, {
          broadcasterId: userId,
          editorId: userId,
          streamId,
          streamStartedAt: stream.started_at,
          streamTitle: stream.title,
          sourceChannel: stream.user_name || stream.user_login,
          gameId: stream.game_id || null,
          gameName: stream.game_name || '',
          vodId: vod && vod.id
        }, result);
      } catch (error) {
        result.communityClipScanError = clean(error && error.message || 'Twitch clip scan failed', 300);
        if (logger && typeof logger.warn === 'function') {
          logger.warn('Amaana live community clip scan failed: ' + result.communityClipScanError);
        }
      }
    }
    if (!vod || vod.type !== 'archive' || String(vod.user_id || '') !== userId ||
        String(vod.stream_id || '') !== streamId || !/^\d+$/.test(String(vod.id || ''))) {
      result.status = 'active_vod_not_ready';
      return result;
    }

    let vodDurationSeconds;
    try {
      vodDurationSeconds = parseTwitchDuration(vod.duration);
    } catch {
      result.status = 'active_vod_not_ready';
      return result;
    }
    const startedAt = Date.parse(stream.started_at || '');
    const elapsedSeconds = Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((timestamp - startedAt) / 1000)) : vodDurationSeconds;
    const availableSeconds = Math.floor(Math.min(vodDurationSeconds, elapsedSeconds));
    const requestedDuration = Math.floor(Number(liveCaptureDurationSeconds));
    const bufferSeconds = Math.max(0, Math.floor(Number(liveCaptureBufferSeconds) || 0));
    const captureOffset = Math.floor(availableSeconds - bufferSeconds);
    if (!Number.isFinite(requestedDuration) || requestedDuration < 15 || requestedDuration > 60 ||
        captureOffset < requestedDuration) {
      result.status = 'waiting_for_live_footage';
      return result;
    }

    const state = await getState();
    let session = state.liveSessions[streamId];
    if (!session || String(session.vodId || '') !== String(vod.id)) {
      session = {
        streamId,
        vodId: String(vod.id),
        batchIndex: 0,
        candidates: [],
        lastCaptureAt: null,
        lastCaptureOffset: null
      };
      state.liveSessions[streamId] = session;
    }
    session.streamId = streamId;
    session.vodId = String(vod.id);
    session.streamUserId = userId;
    session.streamStartedAt = stream.started_at || session.streamStartedAt || null;
    session.sourceChannel = clean(stream.user_name || stream.user_login, 50);
    session.streamTitle = clean(stream.title, 100);
    session.lastSeenAt = new Date(timestamp).toISOString();
    if (!Array.isArray(session.candidates)) session.candidates = [];
    if (!Array.isArray(session.shortCandidates)) session.shortCandidates = [];
    await queueReadyLiveShorts(stream, session, result);
    await queueReadyLiveBatches(vod, stream, session, result);

    const lastCaptureAt = Date.parse(session.lastCaptureAt || '');
    const captureDue = !Number.isFinite(lastCaptureAt) ||
      timestamp - lastCaptureAt >= liveCaptureIntervalMs;
    const previousOffset = Number(session.lastCaptureOffset);
    const newSegmentAvailable = !Number.isFinite(previousOffset) ||
      captureOffset - previousOffset >= requestedDuration + 30;
    if (!captureDue || !newSegmentAvailable) {
      result.status = result.batchesQueued ? 'queued' : 'waiting_for_next_capture';
      await saveState();
      return result;
    }

    const requestedVodOffset = captureOffset;
    const requestedStart = requestedVodOffset - requestedDuration;
    session.lastCaptureAt = new Date(timestamp).toISOString();
    session.lastCaptureOffset = requestedVodOffset;
    session.captureAttempts = (Number(session.captureAttempts) || 0) + 1;
    session.lastCaptureError = null;
    await saveState();
    result.captureAttempted = true;
    try {
      const created = await twitch.createClipFromVod({
        vodId: String(vod.id),
        vodOffset: requestedVodOffset,
        duration: requestedDuration,
        title: clean((stream.title || 'Livestream') + ' | gameplay capture', 100)
      });
      if (!created || !created.id) throw new Error('Twitch did not return a live clip ID');
      const download = await twitch.waitForClipDownload({
        clipId: created.id, broadcasterId: created.broadcasterId || userId,
        editorId: created.editorId || userId
      });
      if (!download || !download.landscape_download_url) {
        throw new Error('Twitch did not provide a landscape live clip');
      }

      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amaana-live-'));
      const source = path.join(directory, 'source.mp4');
      try {
        await twitch.downloadClip(download.landscape_download_url, source);
        const media = await video.inspectMedia(source);
        if (!Number.isFinite(Number(media.durationSeconds)) ||
            Math.abs(Number(media.durationSeconds) - requestedDuration) > 1.5 ||
            !Number.isFinite(Number(media.width)) || !Number.isFinite(Number(media.height)) ||
            Number(media.height) <= 0 || Number(media.width) / Number(media.height) < 1.6) {
          throw new Error('Live Twitch clip failed landscape gameplay media checks');
        }
        const gameplay = await video.verifyGameplay(source);
        const totalFrames = Number(gameplay && gameplay.totalFrames);
        const activeFrames = Number(gameplay && gameplay.activeGameplayFrames);
        const confidence = Number(gameplay && gameplay.confidence);
        if (gameplay?.verified !== true || !Number.isFinite(totalFrames) || totalFrames < 5 ||
            !Number.isFinite(activeFrames) || activeFrames < Math.ceil(totalFrames * 0.8) || activeFrames > totalFrames ||
            !Number.isFinite(confidence) || confidence < 0.8 || confidence > 1) {
          result.gameplayRejected += 1;
          session.lastCaptureError = 'Gameplay screening did not meet the verified-frame threshold';
          result.status = 'gameplay_rejected';
        } else {
          let metadata = null;
          if (typeof twitch.getClip === 'function') {
            try { metadata = await twitch.getClip(created.id); }
            catch (error) {
              if (Number(error && error.status) !== 425) throw error;
            }
          }
          if (metadata && metadata.video_id &&
              String(metadata.video_id) !== String(vod.id)) {
            throw new Error('Twitch live clip metadata points to a different VOD');
          }
          if (metadata && metadata.broadcaster_id &&
              String(metadata.broadcaster_id) !== userId) {
            throw new Error('Twitch live clip metadata points to a different broadcaster');
          }
          if (metadata && metadata.vod_offset !== null && metadata.vod_offset !== undefined) {
            const actualStart = Number(metadata.vod_offset);
            if (!Number.isFinite(actualStart) || Math.abs(actualStart - requestedStart) > 2) {
              throw new Error('Twitch live clip timestamp does not match the requested VOD segment');
            }
          }
          if (metadata && metadata.duration !== null && metadata.duration !== undefined) {
            const actualDuration = Number(metadata.duration);
            if (!Number.isFinite(actualDuration) ||
                Math.abs(actualDuration - requestedDuration) > 1) {
              throw new Error('Twitch live clip duration does not match the requested segment');
            }
          }

          const gameId = clean(metadata && metadata.game_id || stream.game_id, 40) ||
            'visual_gameplay_verified';
          const clip = {
            ...created,
            requestedVodId: String(vod.id),
            requestedVodOffset,
            requestedDuration,
            requestProofVersion: 1,
            requestProofReconstructed: false,
            liveCapture: true,
            visualGameplayVerification: {
              verified: true,
              activeGameplayFrames: activeFrames,
              totalFrames,
              confidence,
              gameName: clean(gameplay.gameName || stream.game_name || '', 100),
              model: clean(gameplay.model || '', 80)
            }
          };
          if (!session.candidates.some((candidate) => String(candidate.clip && candidate.clip.id) === String(clip.id))) {
            session.candidates.push({
              clip,
              gameId,
              startSeconds: requestedStart,
              duration: requestedDuration,
              viewCount: Math.max(0, Number(metadata && metadata.view_count) || 0),
              createdAt: metadata && metadata.created_at || new Date(timestamp).toISOString(),
              title: clean(metadata && metadata.title || stream.title || 'Live gameplay moment', 100)
            });
            session.shortCandidates.push(session.candidates[session.candidates.length - 1]);
            session.candidates = session.candidates.slice(-MAX_LIVE_CANDIDATES);
            session.shortCandidates = session.shortCandidates.slice(-LIVE_SHORT_CANDIDATE_GROUP_SIZE * 2);
          }
          session.lastCaptureError = null;
          await saveState();
          result.captureAccepted = true;
          result.candidatesVerified = 1;
          result.status = 'candidate_verified';
        }
      } finally {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      session.lastCaptureError = clean(error && error.message || 'Live Twitch capture failed', 300);
      result.captureError = session.lastCaptureError;
      result.status = 'capture_failed';
      if (logger && typeof logger.error === 'function') {
        logger.error('Amaana live Twitch clip capture failed for stream ' + streamId + ': ' + error.message);
      }
    }

    await queueReadyLiveShorts(stream, session, result);
    await queueReadyLiveBatches(vod, stream, session, result);
    await saveState();
    return result;
  }

  async function runLive() {
    if (liveRunning) return { skipped: 'already_running' };
    liveRunning = true;
    lastLiveRunError = null;
    let result = { status: 'idle', live: false, captureAttempted: false, captureAccepted: false,
      candidatesVerified: 0, gameplayRejected: 0, batchesQueued: 0 };
    try {
      if (typeof twitch.isConnected === 'function' && !await twitch.isConnected()) {
        result.notConnected = true;
      } else {
        result = await scanLiveBroadcast();
      }
      lastLiveRunAt = new Date(now()).toISOString();
      lastLiveRunResult = result;
      return result;
    } catch (error) {
      lastLiveRunAt = new Date(now()).toISOString();
      lastLiveRunError = error.message;
      lastLiveRunResult = result;
      if (logger && typeof logger.error === 'function') {
        logger.error('Amaana live Twitch highlight scan failed: ' + error.message);
      }
      return result;
    } finally {
      liveRunning = false;
    }
  }

  async function run() {
    if (running) return { skipped: 'already_running' };
    running = true;
    const result = {
      vodsSeen: 0, scanned: 0, queued: 0, testStreamsSkipped: 0, noCandidates: 0, insufficientGameplayDuration: 0,
      qualityFloorRejected: 0, visualScreeningUnavailable: 0,
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
        if (isPlaceholderTestTitle(vod.title)) {
          result.scanned += 1;
          result.testStreamsSkipped += 1;
          await markScanned(vodId);
          continue;
        }
        const existing = drafts.find((draft) => draft && draft.sourceType === 'twitch_highlight_batch' &&
          String(draft.vodId) === vodId &&
          Number(draft.targetHighlightDurationSeconds) === Number(targetDurationSeconds));
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
          else if (scan.status === 'insufficient_quality_gameplay') result.qualityFloorRejected += 1;
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
    if (!timer) {
      timer = setInterval(() => { void run(); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      void run();
    }
    if (!liveTimer) {
      liveTimer = setInterval(() => { void runLive(); }, liveScanIntervalMs);
      if (typeof liveTimer.unref === 'function') liveTimer.unref();
      void runLive();
    }
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (liveTimer) clearInterval(liveTimer);
    timer = null;
    liveTimer = null;
  }

  function status() {
    return { running, lastRunAt, lastRunResult, lastRunError,
      liveRunning, lastLiveRunAt, lastLiveRunResult, lastLiveRunError };
  }

  return { run, runLive, scanVod, start, stop, status };
}

module.exports = {
  createTwitchHighlightDiscovery,
  selectCommunityHighlights,
  scanIntervalForVod,
  DEFAULT_SCAN_INTERVAL_MS,
  DEFAULT_LIVE_SCAN_INTERVAL_MS,
  DEFAULT_LIVE_CAPTURE_INTERVAL_MS,
  DEFAULT_LIVE_CAPTURE_DURATION_SECONDS,
  DEFAULT_LIVE_CAPTURE_BUFFER_SECONDS,
  MAX_LIVE_CANDIDATES,
  RECENT_VOD_LIMIT,
  MAX_AUTO_HIGHLIGHTS
};
