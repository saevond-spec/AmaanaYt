'use strict';

const { normalizeJapaneseChannelLocalization } = require('./channel-localization');
const { translateJapaneseVideoLocalizations } = require('./japanese-translation');
const { youtubeQuotaDate, callYouTubeDataApi, getYouTubeDataApiQuotaBlock } = require('./youtube-quota');

const MAX_TRANSLATION_BATCH = 5;
const VIDEO_PAGE_SIZE = 50;
const DEFAULT_DAILY_UPDATE_LIMIT = 100;
const DEFAULT_RUN_UPDATE_LIMIT = 10;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_ERROR_BACKOFF_MS = 60 * 60 * 1000;
const DEFAULT_VIDEO_PAGES_PER_RUN = 10;
const DEFAULT_VIDEO_UPDATES_PER_RUN = 8;
const CHANNEL_TRANSLATION_ID = 'channel0001';

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  status: 'paused',
  videoPageToken: null,
  quotaDate: null,
  updatesToday: 0,
  totalUpdated: 0,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastError: null,
  retryAfter: null,
  lastRun: Object.freeze({ channel: 0, videos: 0, playlists: 0, conflicts: 0 })
});

function boundedSetting(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function normalizeState(value = {}) {
  return {
    ...DEFAULT_STATE,
    ...value,
    enabled: value.enabled === true,
    updatesToday: Number.isSafeInteger(value.updatesToday) && value.updatesToday >= 0 ? value.updatesToday : 0,
    totalUpdated: Number.isSafeInteger(value.totalUpdated) && value.totalUpdated >= 0 ? value.totalUpdated : 0,
    lastRun: { ...DEFAULT_STATE.lastRun, ...(value.lastRun || {}) }
  };
}

function hasJapaneseLocalization(item) {
  return Boolean(item?.localizations && Object.prototype.hasOwnProperty.call(item.localizations, 'ja'));
}

function isConflict(error) {
  return [404, 409, 412].includes(Number(error?.status || error?.code));
}

function createJapaneseLocalizationWorker({
  store,
  youtube,
  env = process.env,
  logger = console,
  now = Date.now,
  translate = translateJapaneseVideoLocalizations,
  intervalMs = DEFAULT_INTERVAL_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  maxVideoPagesPerRun = DEFAULT_VIDEO_PAGES_PER_RUN,
  dailyUpdateLimit,
  runUpdateLimit
} = {}) {
  if (!store?.getJapaneseLocalizationAutopilotState || !store?.saveJapaneseLocalizationAutopilotState || !youtube) {
    throw new TypeError('Japanese localization autopilot requires a store and YouTube client');
  }

  const dailyLimit = boundedSetting(dailyUpdateLimit || env.YOUTUBE_JA_LOCALIZATION_DAILY_LIMIT,
    DEFAULT_DAILY_UPDATE_LIMIT, DEFAULT_DAILY_UPDATE_LIMIT);
  const perRunLimit = boundedSetting(runUpdateLimit || env.YOUTUBE_JA_LOCALIZATION_RUN_LIMIT,
    DEFAULT_RUN_UPDATE_LIMIT, 20);
  let running = false;
  let scheduled = false;
  let lastRunAt = 0;

  const timestamp = () => new Date(now()).toISOString();
  const today = () => youtubeQuotaDate(now());

  async function readState() {
    return normalizeState(await store.getJapaneseLocalizationAutopilotState());
  }

  async function writeState(state) {
    const latest = normalizeState(await store.getJapaneseLocalizationAutopilotState());
    const normalized = normalizeState({ ...state, enabled: latest.enabled });
    await store.saveJapaneseLocalizationAutopilotState(normalized);
    return normalized;
  }

  async function stateIsEnabled() {
    return (await store.getJapaneseLocalizationAutopilotState())?.enabled === true;
  }

  async function makeTranslations(entries) {
    return translate(entries, {
      apiKey: env.SEO_AI_API_KEY,
      model: env.SEO_AI_MODEL,
      baseUrl: env.SEO_AI_BASE_URL || 'https://api.openai.com/v1',
      timeoutMs: env.SEO_AI_TIMEOUT_MS
    });
  }

  async function run() {
    if (running) return readState();
    let state = await readState();
    if (!state.enabled) return state;
    const runDate = today();
    if (state.quotaDate !== runDate) {
      state.quotaDate = runDate;
      state.updatesToday = 0;
    }
    if (state.retryAfter && Date.parse(state.retryAfter) > now()) return state;
    const globalQuotaBlock = await getYouTubeDataApiQuotaBlock(store, now());
    if (globalQuotaBlock) {
      state.status = 'quota_wait';
      state.retryAfter = new Date(globalQuotaBlock.blockedUntil).toISOString();
      state.lastError = 'YouTube Data API quota paused until ' + state.retryAfter;
      return writeState(state);
    }
    if (state.updatesToday >= dailyLimit) {
      state.status = 'quota_wait';
      state.lastError = null;
      return writeState(state);
    }

    running = true;
    lastRunAt = now();
    state.status = 'running';
    state.lastError = null;
    state.retryAfter = null;
    state.lastRunStartedAt = timestamp();
    state.lastRun = { channel: 0, videos: 0, playlists: 0, conflicts: 0 };
    state = await writeState(state);

    const stats = { channel: 0, videos: 0, playlists: 0, conflicts: 0 };
    const availableToday = dailyLimit - state.updatesToday;
    const runLimit = Math.min(perRunLimit, availableToday);
    let attemptedThisRun = 0;

    function remaining() {
      return Math.max(0, runLimit - attemptedThisRun);
    }

    async function persistProgress() {
      state.lastRun = { ...stats };
      state = await writeState(state);
    }

    async function apply(kind, item, localization) {
      if (!item.etag) {
        stats.conflicts += 1;
        return false;
      }
      attemptedThisRun += 1;
      try {
        if (kind === 'channel') {
          await callYouTubeDataApi(store, () => youtube.updateJapaneseChannelLocalization(
            { id: item.id, etag: item.etag }, localization), now());
          stats.channel += 1;
        } else if (kind === 'video') {
          await callYouTubeDataApi(store, () => youtube.updateJapaneseVideoLocalization(
            { id: item.id, etag: item.etag }, localization), now());
          stats.videos += 1;
        } else {
          await callYouTubeDataApi(store, () => youtube.updateJapanesePlaylistLocalization(
            { id: item.id, etag: item.etag }, localization), now());
          stats.playlists += 1;
        }
        state.updatesToday += 1;
        state.totalUpdated += 1;
        state.quotaDate = runDate;
        await persistProgress();
        return true;
      } catch (error) {
        if (isConflict(error)) {
          stats.conflicts += 1;
          await persistProgress();
          return false;
        }
        throw error;
      }
    }

    try {
      if (!env.SEO_AI_API_KEY || !env.SEO_AI_MODEL) {
        const error = new Error('Configure SEO_AI_API_KEY and SEO_AI_MODEL to enable Japanese autopilot');
        error.status = 503;
        throw error;
      }
      if (typeof youtube.isConnected === 'function' && !await youtube.isConnected()) {
        const error = new Error('Connect the YouTube owner account to enable Japanese autopilot');
        error.status = 409;
        throw error;
      }

      if (remaining() > 0 && await stateIsEnabled()) {
        const channel = await callYouTubeDataApi(store, () => youtube.channelSeo(), now());
        if (channel?.id && channel.title?.trim() && channel.description?.trim() &&
            !hasJapaneseLocalization(channel)) {
          const translated = await makeTranslations([{
            id: CHANNEL_TRANSLATION_ID,
            title: channel.title || '',
            description: channel.description || '',
            descriptionLimit: 1000
          }]);
          const entry = translated.find((item) => item.id === CHANNEL_TRANSLATION_ID);
          if (!entry) throw new Error('Japanese translator omitted the channel profile');
          if (await stateIsEnabled()) {
            await apply('channel', channel, normalizeJapaneseChannelLocalization(entry));
          }
        }
      }

      let cursor = state.videoPageToken || null;
      let pagesRead = 0;
      let videoAttempts = 0;
      while (remaining() > 0 && videoAttempts < DEFAULT_VIDEO_UPDATES_PER_RUN &&
          pagesRead < maxVideoPagesPerRun && await stateIsEnabled()) {
        const inputCursor = cursor;
        let page;
        try {
          page = await callYouTubeDataApi(store, () => youtube.ownedVideosCursorPage(inputCursor), now());
        } catch (error) {
          if (inputCursor && Number(error?.status || error?.code) === 400) {
            cursor = null;
            state.videoPageToken = null;
            await persistProgress();
            pagesRead += 1;
            continue;
          }
          throw error;
        }
        const videos = Array.isArray(page?.items) ? page.items : [];
        const missing = videos.filter((item) => item?.id && item.snippet?.channelId === page.channelId &&
          !hasJapaneseLocalization(item));
        let pageComplete = true;

        for (let index = 0; index < missing.length;) {
          if (remaining() <= 0 || videoAttempts >= DEFAULT_VIDEO_UPDATES_PER_RUN || !await stateIsEnabled()) {
            pageComplete = false;
            break;
          }
          const batchSize = Math.min(MAX_TRANSLATION_BATCH, remaining(),
            DEFAULT_VIDEO_UPDATES_PER_RUN - videoAttempts, missing.length - index);
          const batch = missing.slice(index, index + batchSize);
          const translations = await makeTranslations(batch.map((item) => ({
            id: item.id,
            title: item.snippet?.title || '',
            description: item.snippet?.description || ''
          })));
          const byId = new Map(translations.map((item) => [item.id, item]));
          for (const item of batch) {
            if (!await stateIsEnabled()) {
              pageComplete = false;
              break;
            }
            const localization = byId.get(item.id);
            if (!localization) throw new Error('Japanese translator omitted video ' + item.id);
            await apply('video', item, localization);
            videoAttempts += 1;
            index += 1;
            if (remaining() <= 0 || videoAttempts >= DEFAULT_VIDEO_UPDATES_PER_RUN) {
              if (index < missing.length) pageComplete = false;
              break;
            }
          }
          if (!pageComplete) break;
        }

        if (!pageComplete) {
          state.videoPageToken = inputCursor;
          await persistProgress();
          break;
        }

        cursor = page?.nextPageToken || null;
        state.videoPageToken = cursor;
        await persistProgress();
        pagesRead += 1;
        if (!cursor) break;
      }

      if (!await stateIsEnabled()) {
        state.enabled = false;
        state.status = 'paused';
        state.lastRunFinishedAt = timestamp();
        return writeState(state);
      }

      if (remaining() > 0) {
        const playlists = await callYouTubeDataApi(store, () => youtube.listOwnedPlaylists(), now());
        const missing = (Array.isArray(playlists) ? playlists : [])
          .filter((item) => item?.id && !hasJapaneseLocalization(item));
        for (let index = 0; index < missing.length;) {
          if (remaining() <= 0 || !await stateIsEnabled()) break;
          const batch = missing.slice(index, index + Math.min(MAX_TRANSLATION_BATCH, remaining()));
          const translations = await makeTranslations(batch.map((item) => ({
            id: item.id,
            title: item.title || '',
            description: item.description || '',
            titleLimit: 150
          })));
          const byId = new Map(translations.map((item) => [item.id, item]));
          for (const item of batch) {
            if (!await stateIsEnabled()) break;
            const localization = byId.get(item.id);
            if (!localization) throw new Error('Japanese translator omitted playlist ' + item.id);
            await apply('playlist', item, localization);
            index += 1;
            if (remaining() <= 0) break;
          }
        }
      }

      state = await readState();
      state.lastRun = { ...stats };
      state.lastRunFinishedAt = timestamp();
      state.lastError = null;
      state.retryAfter = null;
      state.status = state.enabled
        ? state.updatesToday >= dailyLimit ? 'quota_wait' : 'monitoring'
        : 'paused';
      return await writeState(state);
    } catch (error) {
      const quotaBlock = error?.youtubeDataApiQuotaBlock || null;
      if (quotaBlock?.persistenceError) {
        logger.warn?.('Japanese localization quota pause could not be persisted: ' +
          String(quotaBlock.persistenceError.message || quotaBlock.persistenceError).slice(0, 200));
      }
      state = await readState();
      state.status = state.enabled ? quotaBlock ? 'quota_wait' : 'error' : 'paused';
      state.lastRun = { ...stats };
      state.lastRunFinishedAt = timestamp();
      state.lastError = String(error?.message || 'Japanese localization autopilot failed').slice(0, 300);
      state.retryAfter = state.enabled ? quotaBlock
        ? new Date(quotaBlock.blockedUntil).toISOString()
        : new Date(now() + errorBackoffMs).toISOString() : null;
      if (quotaBlock) logger.warn?.('Japanese localization autopilot paused until ' + state.retryAfter +
        ' after YouTube Data API quota limit');
      else logger.error?.('Japanese localization autopilot failed:', error?.message || error);
      return await writeState(state);
    } finally {
      running = false;
    }
  }

  function schedule(force = false) {
    if (running || scheduled || !force && now() - lastRunAt < intervalMs) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      run().catch((error) => logger.error?.('Japanese localization autopilot failed:', error.message));
    });
  }

  async function resumeAfterYouTubeReconnect() {
    const state = await readState();
    if (!state.enabled) return state;
    state.status = 'queued';
    state.lastError = null;
    state.retryAfter = null;
    const updated = await writeState(state);
    schedule(true);
    return updated;
  }

  return { dailyLimit, perRunLimit, getState: readState, run, schedule, resumeAfterYouTubeReconnect };
}

module.exports = {
  DEFAULT_DAILY_UPDATE_LIMIT,
  DEFAULT_RUN_UPDATE_LIMIT,
  hasJapaneseLocalization,
  normalizeState,
  createJapaneseLocalizationWorker
};

