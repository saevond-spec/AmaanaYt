const { normalizeSource, normalizeContext, generatePackage } = require('./seo-package');

function createSeoWorker({ store, youtube, env = process.env, logger = console }) {
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
      const remaining = Math.min(2, dailyLimit - counts.attemptedToday);
      for (let index = 0; index < remaining; index += 1) {
        const job = await store.claimSeoVideo();
        if (!job) break;
        try {
          // Catalog rows start with an empty JSON context; normalize it before reading markers.
          const context = normalizeContext(job.context, job.source.durationSeconds, true);
          const generated = await generatePackage(job.source, context, {
            apiKey: env.SEO_AI_API_KEY, model: env.SEO_AI_MODEL,
            baseUrl: env.SEO_AI_BASE_URL || 'https://api.openai.com/v1'
          });
          await store.finishSeoVideo(job.videoId, job.claimToken, generated, null);
        } catch (error) {
          logger.error(`SEO package ${job.videoId} failed:`, error.message);
          await store.finishSeoVideo(job.videoId, job.claimToken, null, {
            message: String(error.message).slice(0, 300), attempts: job.attempts, retry: job.attempts < 3
          });
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
    await store.saveSeoSyncState(updated);
    if (enabled) schedule(true);
    return updated;
  }

  return { schedule, run, registerUpload, status, setBackfill };
}

module.exports = { createSeoWorker };
