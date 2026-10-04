const { normalizeSource, normalizeContext, generatePackage, createModelCircuitBreaker } = require('./seo-package');
const { analyzeVideo } = require('./video-analysis');
const { createSeoPublisher } = require('./seo-publish');

function createSeoWorker({ store, youtube, env = process.env, logger = console, sleep,
  generate = generatePackage, analyze = analyzeVideo, market = null, playlistAuto = null }) {
  let running = false;
  let scheduled = false;
  let rerunRequested = false;
  let lastRun = 0;
  let lastDiagnostic = null;
  let legacyTagRecoveryChecked = false;
  const configuredLimit = Number(env.SEO_DAILY_LIMIT);
  const dailyLimit = Number.isSafeInteger(configuredLimit) && configuredLimit >= 1 ? configuredLimit : 200;
  const configuredAnalysisBatch = Number(env.SEO_ANALYSIS_BATCH_SIZE);
  const analysisBatchSize = Number.isSafeInteger(configuredAnalysisBatch) && configuredAnalysisBatch >= 1
    ? Math.min(50, configuredAnalysisBatch) : 20;
  const configuredCatalogPages = Number(env.SEO_CATALOG_PAGES_PER_RUN);
  const catalogPagesPerRun = Number.isSafeInteger(configuredCatalogPages) && configuredCatalogPages >= 1
    ? Math.min(20, configuredCatalogPages) : 10;
  const circuitBreaker = createModelCircuitBreaker();
  const analysisCircuitBreaker = createModelCircuitBreaker();
  const analysisEnabled = env.ENABLE_VIDEO_ANALYSIS === 'true';
  const autoPublishEnabled = env.SEO_AUTO_PUBLISH === 'true' &&
    typeof store.listSeoAutoCandidates === 'function' && typeof youtube.updateVideoSeo === 'function';
  const publisher = autoPublishEnabled ? createSeoPublisher({ store, youtube, logger }) : null;

  async function videoAnalysis(job, state) {
    if (!analysisEnabled) return null;
    const id = job.videoId;
    if (job.source.privacyStatus !== 'public') {
      logger.info?.(`analysis_skipped ${id}: video is not public`);
      return null;
    }
    try {
      const cached = await store.getVideoAnalysis(id);
      if (cached?.analysis) {
        logger.info?.(`analysis_skipped ${id}: cached`);
        return cached.analysis;
      }
      if (Date.parse(state.videoAnalysisBlockedUntil) > Date.now()) {
        logger.info?.(`analysis_skipped ${id}: provider cooling down`);
        return null;
      }
      const gemini = (env.SEO_AI_BASE_URL || '').startsWith('https://generativelanguage.googleapis.com/');
      const apiKey = env.VIDEO_ANALYSIS_API_KEY || (gemini ? env.SEO_AI_API_KEY : null);
      if (!apiKey) {
        logger.info?.(`analysis_skipped ${id}: configure a Gemini video analysis key`);
        return null;
      }
      const model = env.VIDEO_ANALYSIS_MODEL || (gemini ? env.SEO_AI_MODEL : 'gemini-3.8-flash');
      logger.info?.(`analysis_started ${id}`);
      const analysis = await analyze(`https://www.youtube.com/watch?v=${id}`, {
        apiKey, model, durationSeconds: job.source.durationSeconds,
        fallbackModels: [env.SEO_AI_FALLBACK_MODEL || 'gemini-3.5-flash-lite',
          env.SEO_AI_SECONDARY_MODEL || 'gemini-3.1-flash-lite',
          env.SEO_AI_FINAL_MODEL || 'gemini-3.8-flash'],
        timeoutMs: env.VIDEO_ANALYSIS_TIMEOUT_MS, circuitBreaker: analysisCircuitBreaker,
        ...(sleep ? { sleep } : {})
      });
      await store.saveVideoAnalysis(id, analysis, analysis.model);
      logger.info?.(`analysis_completed ${id}: model=${analysis.model}`);
      if (state.videoAnalysisBlockedUntil || state.consecutiveAnalysis503s) {
        state.videoAnalysisBlockedUntil = null;
        state.consecutiveAnalysis503s = 0;
        await store.saveSeoSyncState(state);
      }
      return analysis;
    } catch (error) {
      logger.warn?.(`analysis_failed ${id}: ${error.status ? `HTTP ${error.status}` : error.message}`);
      if ([429, 503].includes(error.status)) {
        state.consecutiveAnalysis503s = error.status === 503 ? (state.consecutiveAnalysis503s || 0) + 1 : 0;
        const pauseMs = error.status === 429
          ? error.retryAfterPresent ? error.retryAfterMs : 60 * 60 * 1000
          : Math.min(120, 15 * 2 ** state.consecutiveAnalysis503s) * 60 * 1000;
        state.videoAnalysisBlockedUntil = new Date(Date.now() + pauseMs).toISOString();
        await store.saveSeoSyncState(state);
      }
      return null; // Metadata-only generation still runs after analysis fails.
    }
  }

  async function catalogPage(channel, cursor) {
    const page = await youtube.uploadsPage(channel.uploads, cursor);
    const videos = await youtube.videoMetadata(page.ids);
    for (const item of videos) {
      if (item.snippet?.channelId === channel.id) await store.upsertSeoVideo(item.id, normalizeSource(item));
    }
    return page;
  }

  async function assignCatalogPlaylists() {
    const assignBacklog = playlistAuto?.assignCatalogBacklog || playlistAuto?.assignPublicBacklog;
    if (!playlistAuto?.enabled || typeof assignBacklog !== 'function') return;
    try {
      const result = await assignBacklog.call(playlistAuto);
      if (result.attempted) logger.info?.('Automatic playlists: attempted ' + result.attempted +
        ' channel videos; assigned ' + result.assigned);
    } catch (error) {
      logger.warn?.('Automatic playlist scan failed:', error.message);
    }
  }

  async function auditPlaylistCoverage(state) {
    if (!playlistAuto?.enabled || !state.completed ||
        typeof playlistAuto.reconcilePlaylistCoverage !== 'function') return null;
    const previous = state.playlistCoverageAudit || null;
    if (previous?.complete && previous.catalogScanComplete && previous.missingCount === 0) return null;
    const checkedAt = Date.parse(previous?.checkedAt || '');
    const intervalMs = previous?.complete && previous.catalogScanComplete
      ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000;
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < intervalMs) return null;
    try {
      const report = await playlistAuto.reconcilePlaylistCoverage();
      const audit = {
        checkedAt: report.checkedAt || new Date().toISOString(),
        channelId: report.channelId || state.channelId,
        channelTitle: report.channelTitle || state.channelTitle,
        catalogPages: report.catalogPages || 0,
        catalogCount: report.catalogCount || 0,
        playlistCount: report.playlistCount || 0,
        membershipCount: report.membershipCount || 0,
        coveredCount: report.coveredCount || 0,
        publicCoverageCount: report.publicCoverageCount || 0,
        missingCount: report.missingCount || 0,
        failedPlaylistCount: (report.failedPlaylists || []).length,
        complete: report.complete === true,
        catalogScanComplete: report.catalogScanComplete === true,
        requeuedCount: report.requeuedCount || 0
      };
      state.playlistCoverageAudit = audit;
      await store.saveSeoSyncState(state);
      logger.info?.('Automatic playlist coverage audit: ' + audit.coveredCount + '/' +
        audit.catalogCount + ' in a playlist; missing=' + audit.missingCount +
        '; requeued=' + audit.requeuedCount + '; complete=' +
        (audit.complete && audit.catalogScanComplete));
      return audit;
    } catch (error) {
      logger.warn?.('Automatic playlist coverage audit failed:', error.message);
      return null;
    }
  }

  async function run() {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
      if (!await youtube.isConnected()) {
        if (lastDiagnostic !== 'youtube_disconnected') {
          logger.info?.('SEO worker idle: YouTube is not connected');
          lastDiagnostic = 'youtube_disconnected';
        }
        return;
      }
      const channel = await youtube.ownedChannel();
      let state = await store.getSeoSyncState();
      if (state.channelId && state.channelId !== channel.id) {
        throw new Error('YouTube channel changed; SEO backfill is paused to avoid mixing channels');
      }
      // A new owner approval can resume a paused catalog exactly once. Persist the marker
      // so a later pause in the dashboard is respected on every subsequent run.
      const approvalId = env.SEO_OWNER_APPROVAL_ID?.trim();
      if (autoPublishEnabled && approvalId && state.ownerApprovalId !== approvalId) {
        state = { ...state, enabled: true, ownerApprovalId: approvalId };
        await store.saveSeoSyncState(state);
        logger.info?.('SEO backfill resumed by one-time owner approval');
      }
      state = { ...state, channelId: channel.id, channelTitle: channel.title };
      const diagnostic = JSON.stringify({ channelId: channel.id, backfillEnabled: state.enabled !== false,
        autoPublishEnabled, providerConfigured: Boolean(env.SEO_AI_API_KEY && env.SEO_AI_MODEL),
        videoAnalysisEnabled: analysisEnabled,
        analysisProviderConfigured: Boolean(env.VIDEO_ANALYSIS_API_KEY ||
          (env.SEO_AI_BASE_URL || '').startsWith('https://generativelanguage.googleapis.com/') && env.SEO_AI_API_KEY) });
      if (diagnostic !== lastDiagnostic) {
        logger.info?.(`SEO worker configuration: ${diagnostic}`);
        lastDiagnostic = diagnostic;
      }
      if (!state.recentAt || Date.now() - Date.parse(state.recentAt) >= 60 * 60 * 1000) {
        const recent = await catalogPage(channel, null);
        state.recentAt = new Date().toISOString();
        if (!state.completed && !state.cursor) {
          state.cursor = recent.nextPageToken;
          if (!state.cursor) state.completed = true;
        }
        await store.saveSeoSyncState(state);
      }
      if (state.enabled !== false && !state.completed && state.cursor) {
        for (let pageNumber = 0; pageNumber < catalogPagesPerRun && state.cursor; pageNumber += 1) {
          const page = await catalogPage(channel, state.cursor);
          state.cursor = page.nextPageToken;
          if (!state.cursor) state.completed = true;
          await store.saveSeoSyncState(state);
        }
      }
      await assignCatalogPlaylists();
      const coverageAudit = await auditPlaylistCoverage(state);
      if (coverageAudit?.requeuedCount) await assignCatalogPlaylists();
      if (publisher && state.enabled !== false) {
        await publisher.publishPending().catch((error) => logger.warn?.('SEO auto publish scan failed:', error.message));
        await publisher.updateChannel().catch((error) => logger.warn?.('SEO channel update failed:', error.message));
      }
      const gemini = (env.SEO_AI_BASE_URL || '').startsWith('https://generativelanguage.googleapis.com/');
      if (state.enabled !== false && analysisEnabled && env.SEO_AI_API_KEY && env.SEO_AI_MODEL &&
          (env.VIDEO_ANALYSIS_API_KEY || gemini) &&
          !(Date.parse(state.videoAnalysisBlockedUntil) > Date.now()) &&
          typeof store.listSeoNeedsAnalysis === 'function') {
        const candidates = await store.listSeoNeedsAnalysis(analysisBatchSize);
        let requeued = 0;
        for (const candidate of candidates || []) {
          if (await store.updateSeoContext(candidate.videoId, candidate.context)) requeued += 1;
        }
        if (requeued) logger.info?.('Requeued ' + requeued + ' public videos for footage analysis');
      }
      if (!env.SEO_AI_API_KEY || !env.SEO_AI_MODEL || state.enabled === false) return;
      if (!legacyTagRecoveryChecked && typeof store.requeueLegacySeoTagFailures === 'function') {
        try {
          const requeued = await store.requeueLegacySeoTagFailures();
          legacyTagRecoveryChecked = true;
          if (requeued) logger.info?.(`Requeued ${requeued} failed SEO packages with legacy tag-format errors`);
        } catch (error) {
          logger.warn?.(`Legacy SEO tag-failure recovery failed: ${error.message}`);
        }
      }
      const counts = await store.seoCounts();
      logger.info?.(`SEO queue statuses: ${JSON.stringify(counts.statuses || {})}; attemptedToday=${counts.attemptedToday}`);
      const probeTag = gemini ? `final:${env.SEO_AI_FINAL_MODEL || 'gemini-3.8-flash'}` : null;
      if (Date.parse(state.providerBlockedUntil) > Date.now()) {
        // A newly configured model gets one probe; subsequent starts respect the pause.
        if (!probeTag || state.providerProbeTag === probeTag) return;
      }
      if (probeTag && state.providerProbeTag !== probeTag) {
        state.providerProbeTag = probeTag;
        await store.saveSeoSyncState(state);
      }
      // Process the available daily budget even if scheduled wake-ups were delayed.
      const remaining = Math.max(0, dailyLimit - counts.attemptedToday);
      let channelUpdatedAfterPublish = false;
      for (let index = 0; index < remaining; index += 1) {
        const job = await store.claimSeoVideo();
        if (!job) break;
        try {
          // Catalog rows start with an empty JSON context; normalize it before reading markers.
          const context = normalizeContext(job.context, job.source.durationSeconds, true);
          const baseUrl = env.SEO_AI_BASE_URL || 'https://api.openai.com/v1';
          const fallbackModel = baseUrl.startsWith('https://generativelanguage.googleapis.com/')
            ? env.SEO_AI_FALLBACK_MODEL || 'gemini-3.5-flash-lite' : null;
          const secondaryNativeModel = fallbackModel
            ? env.SEO_AI_SECONDARY_MODEL || 'gemini-3.1-flash-lite' : null;
          const finalNativeModel = fallbackModel
            ? env.SEO_AI_FINAL_MODEL || 'gemini-3.8-flash' : null;
          const analysis = await videoAnalysis(job, state);
          const marketEvidence = await market?.research(job.source)
            .catch((error) => { logger.warn?.(`SEO market lookup ${job.videoId} failed: ${error.message}`); }) || null;
          const generated = await generate(job.source, context, {
            apiKey: env.SEO_AI_API_KEY, model: env.SEO_AI_MODEL,
            baseUrl, fallbackModel, secondaryNativeModel, finalNativeModel,
            analysis, marketEvidence, timeoutMs: env.SEO_AI_TIMEOUT_MS, circuitBreaker,
            ...(sleep ? { sleep } : {}),
            onFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying fallback model ${fallback}`),
            onNativeFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying native route with ${fallback}`),
            onSecondNativeFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying second native model ${fallback}`),
            onFinalNativeFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying final native model ${fallback}`)
          });
          await store.finishSeoVideo(job.videoId, job.claimToken, generated, null);
          logger.info?.(`SEO package ${job.videoId} generated: ${generated.missingEvidence.length ? 'needs_review' : 'ready'}`);
          if (publisher) {
            const outcome = await publisher.publishVideo(job.videoId)
              .catch((error) => { logger.warn?.(`SEO auto publish ${job.videoId} failed:`, error.message); });
            if (outcome?.state === 'applied' && !channelUpdatedAfterPublish) {
              await publisher.updateChannel()
                .catch((error) => logger.warn?.('SEO channel update failed:', error.message));
              channelUpdatedAfterPublish = true;
            }
          }
          if (state.providerBlockedUntil || state.consecutive503s) {
            state.providerBlockedUntil = null;
            state.providerError = null;
            state.consecutive503s = 0;
            await store.saveSeoSyncState(state);
          }
        } catch (error) {
          logger.error(`SEO package ${job.videoId} failed:`, error.message,
            error.status ? `route=${error.route || 'unknown'} contentType=${error.contentType || 'unknown'}` : '');
          const balanceBlocked = error.status === 402;
          const transientProviderError = [408, 429, 500, 502, 503, 504].includes(error.status);
          await store.finishSeoVideo(job.videoId, job.claimToken, null, {
            message: String(error.message).slice(0, 300), attempts: job.attempts,
            retry: balanceBlocked || transientProviderError || job.attempts < 3
          });
          if (balanceBlocked || transientProviderError) {
            state.consecutive503s = error.status === 503 ? (state.consecutive503s || 0) + 1 : 0;
            const pauseMs = balanceBlocked ? 120 * 60 * 1000 : error.status === 429
              ? error.retryAfterPresent ? error.retryAfterMs : 60 * 60 * 1000
              : error.status === 503 ? Math.min(120, 15 * 2 ** state.consecutive503s) * 60 * 1000
                : 15 * 60 * 1000;
            state.providerBlockedUntil = new Date(Date.now() + pauseMs).toISOString();
            state.providerError = balanceBlocked ? 'AI provider balance is insufficient (HTTP 402)' :
              `AI provider temporarily unavailable (HTTP ${error.status}); queued videos will retry`;
            await store.saveSeoSyncState(state);
            break;
          }
          if (state.consecutive503s) {
            state.consecutive503s = 0;
            await store.saveSeoSyncState(state);
          }
        }
      }
      if (publisher) await publisher.updateChannel()
        .catch((error) => logger.warn?.('SEO channel update failed:', error.message));
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        schedule(true);
      }
    }
  }

  function schedule(force = false) {
    if (running) { if (force) rerunRequested = true; return; }
    if (scheduled || !force && Date.now() - lastRun < 60 * 60 * 1000) return;
    scheduled = true;
    setImmediate(async () => {
      scheduled = false;
      try { await run(); } catch (error) { logger.error('SEO backfill failed:', error.message); }
    });
  }

  async function registerUpload(videoId, fields) {
    // Record the video immediately; YouTube's read API may not expose an upload while it processes.
    const video = await youtube.getVideo(videoId).catch(() => null);
    const source = video ? normalizeSource(video) : {
      title: fields.title, description: fields.description || '', tags: fields.tags || [],
      channelId: null, publishedAt: new Date().toISOString(),
      privacyStatus: 'private', durationSeconds: fields.durationSeconds ?? null
    };
    if (source.durationSeconds === null && fields.durationSeconds != null) source.durationSeconds = fields.durationSeconds;
    await store.upsertSeoVideo(videoId, source);
    if (fields.context || fields.markers) {
      const context = normalizeContext({ ...fields.context, markers: fields.markers || fields.context?.markers || [] },
        source.durationSeconds, Boolean(fields.markers));
      await store.updateSeoContext(videoId, context);
    }
    schedule(true);
  }

  async function status() {
    const [state, counts] = await Promise.all([store.getSeoSyncState(), store.seoCounts()]);
    return { ...state, ...counts, dailyLimit, analysisBatchSize, videoAnalysisEnabled: analysisEnabled,
      providerConfigured: Boolean(env.SEO_AI_API_KEY && env.SEO_AI_MODEL), autoPublishEnabled,
      catalogPagesPerRun, running };
  }

  async function setBackfill(enabled, restart = false) {
    const state = await store.getSeoSyncState();
    const updated = { ...state, enabled };
    if (restart) {
      updated.cursor = null;
      updated.completed = false;
      updated.recentAt = null;
      updated.playlistCoverageAudit = null;
      if (typeof store.resetSeoPlaylistResults === 'function') {
        const requeued = await store.resetSeoPlaylistResults();
        if (requeued) logger.info?.(`Requeued ${requeued} videos for automatic playlist matching`);
      }
    }
    if (enabled) { updated.providerBlockedUntil = null; updated.providerError = null; }
    await store.saveSeoSyncState(updated);
    if (enabled) schedule(true);
    return updated;
  }

  return { schedule, run, registerUpload, status, setBackfill };
}

module.exports = { createSeoWorker };
