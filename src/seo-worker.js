const { normalizeSource, normalizeContext, generatePackage } = require('./seo-package');

function createSeoWorker({ store, youtube, env = process.env, logger = console, sleep }) {
  let running = false;
  let scheduled = false;
  let rerunRequested = false;
  let lastRun = 0;
  const dailyLimit = Math.min(100, Math.max(1, Number(env.SEO_DAILY_LIMIT) || 20));

  async function catalogPage(channel, cursor) {
    const page = await youtube.uploadsPage(channel.uploads, cursor);
    const videos = await youtube.videoMetadata(page.ids);
    for (const item of videos) {
      if (item.snippet?.channelId === channel.id) await store.upsertSeoVideo(item.id, normalizeSource(item));
    }
    return page;
  }

  async function run() {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
      if (!await youtube.isConnected()) return;
      const channel = await youtube.ownedChannel();
      let state = await store.getSeoSyncState();
      if (state.channelId && state.channelId !== channel.id) {
        throw new Error('YouTube channel changed; SEO backfill is paused to avoid mixing channels');
      }
      state = { ...state, channelId: channel.id, channelTitle: channel.title };
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
        const page = await catalogPage(channel, state.cursor);
        state.cursor = page.nextPageToken;
        if (!state.cursor) state.completed = true;
        await store.saveSeoSyncState(state);
      }
      if (!env.SEO_AI_API_KEY || !env.SEO_AI_MODEL || state.enabled === false) return;
      const counts = await store.seoCounts();
      logger.info?.(`SEO queue statuses: ${JSON.stringify(counts.statuses || {})}; attemptedToday=${counts.attemptedToday}`);
      const gemini = (env.SEO_AI_BASE_URL || '').startsWith('https://generativelanguage.googleapis.com/');
      const probeTag = gemini ? `final:${env.SEO_AI_FINAL_MODEL || 'gemini-3.8-flash'}` : null;
      if (Date.parse(state.providerBlockedUntil) > Date.now()) {
        // A newly configured model gets one probe; subsequent starts respect the pause.
        if (!probeTag || state.providerProbeTag === probeTag) return;
      }
      if (probeTag && state.providerProbeTag !== probeTag) {
        state.providerProbeTag = probeTag;
        await store.saveSeoSyncState(state);
      }
      // Scheduled wake-ups can be delayed; use the daily cap even when fewer wakes arrive.
      const remaining = Math.min(5, dailyLimit - counts.attemptedToday);
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
          const generated = await generatePackage(job.source, context, {
            apiKey: env.SEO_AI_API_KEY, model: env.SEO_AI_MODEL,
            baseUrl, fallbackModel, secondaryNativeModel, finalNativeModel,
            ...(sleep ? { sleep } : {}),
            onFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying fallback model ${fallback}`),
            onNativeFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying native route with ${fallback}`),
            onSecondNativeFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying second native model ${fallback}`),
            onFinalNativeFallback: (fallback) => logger.info?.(`SEO provider HTTP 503; trying final native model ${fallback}`)
          });
          await store.finishSeoVideo(job.videoId, job.claimToken, generated, null);
          logger.info?.(`SEO package ${job.videoId} generated: ${generated.missingEvidence.length ? 'needs_review' : 'ready'}`);
          if (state.providerBlockedUntil) {
            state.providerBlockedUntil = null;
            state.providerError = null;
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
            const pauseMinutes = balanceBlocked ? 120 : error.status === 429 ? 60 : 15;
            state.providerBlockedUntil = new Date(Date.now() + pauseMinutes * 60 * 1000).toISOString();
            state.providerError = balanceBlocked ? 'AI provider balance is insufficient (HTTP 402)' :
              `AI provider temporarily unavailable (HTTP ${error.status}); queued videos will retry`;
            await store.saveSeoSyncState(state);
            break;
          }
        }
      }
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
    return { ...state, ...counts, dailyLimit, providerConfigured: Boolean(env.SEO_AI_API_KEY && env.SEO_AI_MODEL),
      running };
  }

  async function setBackfill(enabled, restart = false) {
    const state = await store.getSeoSyncState();
    const updated = { ...state, enabled };
    if (restart) { updated.cursor = null; updated.completed = false; updated.recentAt = null; }
    if (enabled) { updated.providerBlockedUntil = null; updated.providerError = null; }
    await store.saveSeoSyncState(updated);
    if (enabled) schedule(true);
    return updated;
  }

  return { schedule, run, registerUpload, status, setBackfill };
}

module.exports = { createSeoWorker };
