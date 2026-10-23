const { isYouTubeAuthorizationError } = require('./channel-tags');
const { youtubeQuotaDate, callYouTubeDataApi, getYouTubeDataApiQuotaBlock,
  isYouTubeQuotaError, recordYouTubeDataApiQuotaBlock } = require('./youtube-quota');

const DAY_MS = 24 * 60 * 60 * 1000;
const VELOCITY_PRIOR_DAYS = 2;
const MIN_MARKET_SAMPLE_AGE_DAYS = 1 / 24;
const MIN_MARKET_PHRASE_SAMPLE_COUNT = 8;
const MIN_REPEATED_PHRASE_DOCUMENTS = 3;
const MIN_MARKET_PHRASE_CONFIDENCE = 0.25;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you',
  'game', 'gameplay', 'video', 'live', 'stream', 'clip', 'short', 'shorts', 'official']);

const GAMES = [
  ['ARC Raiders', /\bARC\s+Raiders\b/i],
  ['NARAKA: BLADEPOINT', /\bNARAKA\b/i],
  ['Apex Legends', /\bApex\s+Legends\b/i],
  ['Mortal Kombat', /\bMortal\s+Kombat\b/i],
  ['Days Gone', /\bDays\s+Gone\b/i],
  ['Super Animal Royale', /\bSuper\s+Animal\s+Royale\b/i],
  ['Metal Gear Solid V', /\bMetal\s+Gear\s+Solid\b/i],
  ['Off The Grid', /\bOff\s+The\s+Grid\b/i]
];

function detectGame(source) {
  const text = `${source?.title || ''} ${String(source?.description || '').slice(0, 250)}`;
  return GAMES.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

// YouTube Data API does not expose a reliable Shorts/long-form label for public
// search results. Compare length cohorts only; never present these as formats.
function durationBand(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds <= 3 * 60) return 'up_to_3_minutes';
  if (seconds <= 15 * 60) return '3_to_15_minutes';
  if (seconds <= 60 * 60) return '15_to_60_minutes';
  return 'over_60_minutes';
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function titlePhrases(title, game) {
  const gameWords = new Set(String(game || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const words = String(title || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const filtered = words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !gameWords.has(word));
  const phrases = new Set(filtered);
  for (let index = 0; index < filtered.length - 1; index += 1) {
    phrases.add(`${filtered[index]} ${filtered[index + 1]}`);
  }
  return phrases;
}

/**
 * Normalize recent competitor views by age, then shrink short-lived view spikes
 * toward the cohort median. This is an observed search-result sample, not demand.
 */
function summarizeMarketSamples(samples, { now = Date.now(), game = '', durationSeconds = null } = {}) {
  const targetDurationBand = durationBand(durationSeconds);
  const eligible = (Array.isArray(samples) ? samples : []).filter((sample) => {
    const publishedAt = Date.parse(sample?.publishedAt || '');
    const views = Number(sample?.viewCount);
    const sampleDurationBand = durationBand(sample?.durationSeconds);
    return Number.isFinite(publishedAt) && publishedAt <= now && Number.isFinite(views) && views >= 0 &&
      (!targetDurationBand || sampleDurationBand === targetDurationBand);
  }).map((sample) => {
    // Use observed fractional age. The two-day Gamma-Poisson prior below keeps
    // videos published minutes ago from producing unbounded daily-rate spikes.
    const ageDays = Math.max(MIN_MARKET_SAMPLE_AGE_DAYS,
      (now - Date.parse(sample.publishedAt)) / DAY_MS);
    const viewCount = Number(sample.viewCount);
    return { ...sample, ageDays, rawViewsPerDay: viewCount / ageDays, viewCount };
  });
  if (!eligible.length) return { metrics: { sampleCount: 0 }, terms: [], samples: [] };

  const priorViewsPerDay = median(eligible.map((sample) => sample.rawViewsPerDay));
  const smoothed = eligible.map((sample) => ({ ...sample,
    smoothedViewsPerDay: (sample.viewCount + priorViewsPerDay * VELOCITY_PRIOR_DAYS) /
      (sample.ageDays + VELOCITY_PRIOR_DAYS)
  }));
  const velocities = smoothed.map((sample) => sample.smoothedViewsPerDay);
  const center = median(velocities);
  const mad = median(velocities.map((velocity) => Math.abs(velocity - center)));
  const sampleCount = smoothed.length;
  // Sample-size shrinkage and robust dispersion keep a few outliers from looking certain.
  const confidence = (sampleCount / (sampleCount + 5)) / (1 + mad / Math.max(1, center));
  const weightedTerms = new Map();
  for (const sample of smoothed) {
    const normalizedVelocity = Math.log1p(sample.smoothedViewsPerDay / Math.max(1, center));
    for (const phrase of titlePhrases(sample.title, game)) {
      const entry = weightedTerms.get(phrase) || { documents: 0, weight: 0 };
      entry.documents += 1;
      entry.weight += normalizedVelocity;
      weightedTerms.set(phrase, entry);
    }
  }
  const terms = [...weightedTerms.entries()].map(([phrase, entry]) => {
    const support = entry.documents / (entry.documents + 2);
    const inverseDocumentFrequency = 1 + Math.log((sampleCount + 1) / (entry.documents + 1));
    return { phrase, sampleCount: entry.documents,
      score: Number((support * inverseDocumentFrequency * entry.weight / entry.documents).toFixed(4)) };
  }).filter((term) => term.sampleCount >= MIN_REPEATED_PHRASE_DOCUMENTS)
    .sort((left, right) => right.score - left.score || left.phrase.localeCompare(right.phrase)).slice(0, 8);
  // This is an evidence gate, not a statistical significance claim. Search
  // result samples are a small, selected market snapshot, not search volume.
  const marketPhraseEligible = targetDurationBand !== null && sampleCount >= MIN_MARKET_PHRASE_SAMPLE_COUNT &&
    confidence >= MIN_MARKET_PHRASE_CONFIDENCE && terms.length > 0;
  const marketPhraseReason = !targetDurationBand ? 'target_duration_unavailable' :
    sampleCount < MIN_MARKET_PHRASE_SAMPLE_COUNT ? 'too_few_comparable_samples' :
      confidence < MIN_MARKET_PHRASE_CONFIDENCE ? 'weak_sample_consistency' :
        terms.length === 0 ? 'no_repeated_phrase_support' : null;

  const ranked = smoothed.sort((left, right) => right.smoothedViewsPerDay - left.smoothedViewsPerDay ||
    right.viewCount - left.viewCount).slice(0, 5).map(({ id, title, publishedAt, viewCount,
    durationSeconds, rawViewsPerDay, smoothedViewsPerDay }) => ({ id, title, publishedAt, viewCount,
    durationSeconds,
    estimatedViewsPerDay: Math.round(rawViewsPerDay), smoothedViewsPerDay: Math.round(smoothedViewsPerDay),
    velocityIndex: Number((100 * smoothedViewsPerDay / Math.max(1, center)).toFixed(1)) }));
  return {
    metrics: {
      sampleCount,
      durationBand: targetDurationBand,
      comparisonBasis: targetDurationBand ? 'same_game_and_duration_band' : 'same_game_only',
      priorDays: VELOCITY_PRIOR_DAYS,
      priorViewsPerDay: Number(priorViewsPerDay.toFixed(1)),
      medianViewsPerDay: Number(center.toFixed(1)),
      p90ViewsPerDay: Number(quantile(velocities, 0.9).toFixed(1)),
      medianAbsoluteDeviation: Number(mad.toFixed(1)),
      confidenceSemantics: 'heuristic_stability_score_not_probability',
      confidence: Number(confidence.toFixed(3)),
      phraseSuggestionsEligible: marketPhraseEligible,
      phraseSuggestionReason: marketPhraseReason
    },
    terms: marketPhraseEligible ? terms : [],
    samples: ranked
  };
}

function createSeoMarket({ store, youtube, env = process.env, logger = console, now = Date.now }) {
  const enabled = env.SEO_MARKET_RESEARCH === 'true';
  const hasStore = typeof store.getSeoMarketSnapshot === 'function' &&
    typeof store.saveSeoMarketSnapshot === 'function' &&
    typeof store.getSeoMarketBudget === 'function' && typeof store.saveSeoMarketBudget === 'function';
  let refreshing = false;
  let retryAfter = 0;
  let dailyQuotaBlockedUntil = 0;
  const authCooldownMs = 6 * 60 * 60 * 1000;

  async function applyCooldown(error) {
    const quotaBlock = error?.youtubeDataApiQuotaBlock ||
      (isYouTubeQuotaError(error) ? await recordYouTubeDataApiQuotaBlock(store, error, now()) : null);
    if (quotaBlock) {
      dailyQuotaBlockedUntil = quotaBlock.blockedUntil;
      retryAfter = quotaBlock.blockedUntil;
      if (typeof store.getSeoSyncState === 'function' && typeof store.saveSeoSyncState === 'function') {
        try {
          const state = await store.getSeoSyncState();
          await store.saveSeoSyncState({ ...state,
            youtubeDataApiBlockedUntil: new Date(dailyQuotaBlockedUntil).toISOString(),
            youtubeDataApiBlockReason: quotaBlock.reason });
        } catch (saveError) {
          logger.warn?.(`SEO market quota cooldown could not be persisted: ${saveError.message}`);
        }
      }
      return;
    }
    retryAfter = now() + (isYouTubeAuthorizationError(error) ? authCooldownMs : 5 * 60 * 1000);
  }

  async function research(source) {
    if (!enabled || !hasStore ||
        typeof youtube.recentGameVideos !== 'function' || now() < retryAfter) return null;
    const game = detectGame(source);
    const targetDurationBand = durationBand(source?.durationSeconds);
    if (!game || !targetDurationBand) return null;
    const quotaBlock = await getYouTubeDataApiQuotaBlock(store, now());
    if (quotaBlock) {
      dailyQuotaBlockedUntil = quotaBlock.blockedUntil;
      retryAfter = quotaBlock.blockedUntil;
      return null;
    }
    const cached = await store.getSeoMarketSnapshot(game);
    if (cached && now() - Date.parse(cached.observedAt) < 24 * 60 * 60 * 1000) {
      if (!Array.isArray(cached.rawSamples)) return null;
      const summary = summarizeMarketSamples(cached.rawSamples, { now: now(), game,
        durationSeconds: source.durationSeconds });
      return summary.metrics.sampleCount ? { ...cached, ...summary } : null;
    }
    const today = youtubeQuotaDate(now());
    const budget = await store.getSeoMarketBudget();
    const used = budget?.date === today ? budget.used || 0 : 0;
    if (used >= 3) return null;
    await store.saveSeoMarketBudget({ date: today, used: used + 1 });
    try {
      const examples = await callYouTubeDataApi(store, () => youtube.recentGameVideos(game), now());
      const cohort = examples.filter((item) => item.channelId !== source.channelId);
      const rawSamples = cohort.filter((item) => durationBand(item.durationSeconds) !== null)
        .slice(0, 50);
      const summary = summarizeMarketSamples(rawSamples, { now: now(), game,
        durationSeconds: source.durationSeconds });
      const snapshot = { game, query: `${game} gameplay`, observedAt: new Date(now()).toISOString(),
        windowDays: 7, sampleDesign: ['publishedAt', 'viewCount', 'durationSeconds'],
        viewMetricSemantics: { metric: 'public_views', definitionSince: '2026-08-24' },
        rawSamples, ...summary };
      await store.saveSeoMarketSnapshot(game, { ...snapshot, ...summary, rawSamples });
      retryAfter = 0;
      logger.info?.(`SEO market snapshot ${game}: ${snapshot.metrics.sampleCount} recent public search examples; ` +
        `durationBand=${snapshot.metrics.durationBand}, medianVelocity=${snapshot.metrics.medianViewsPerDay}, ` +
        `confidence=${snapshot.metrics.confidence}, phrasesEligible=${snapshot.metrics.phraseSuggestionsEligible}; ` +
        JSON.stringify(snapshot.samples.slice(0, 2)));
      return snapshot.samples.length ? snapshot : null;
    } catch (error) {
      await applyCooldown(error);
      logger.warn?.(`SEO market sample ${game} unavailable: ${error.message}`);
      return null;
    }
  }

  function schedule() {
    if (!enabled || refreshing || now() < retryAfter) return;
    refreshing = true;
    setImmediate(async () => {
      try {
        if (typeof store.getSeoSyncState === 'function') {
          const sharedBlock = await getYouTubeDataApiQuotaBlock(store, now());
          if (sharedBlock) {
            dailyQuotaBlockedUntil = sharedBlock.blockedUntil;
            retryAfter = sharedBlock.blockedUntil;
            return;
          }
          const state = await store.getSeoSyncState();
          const blockedUntil = Date.parse(state?.youtubeDataApiBlockedUntil || '');
          if (Number.isFinite(blockedUntil) && blockedUntil > now()) {
            dailyQuotaBlockedUntil = blockedUntil;
            retryAfter = blockedUntil;
            return;
          }
        }
        if (!await youtube.isConnected()) return;
        const channel = await callYouTubeDataApi(store, () => youtube.ownedChannel(), now());
        await callYouTubeDataApi(store, () => youtube.assertTargetChannel(channel.id), now());
        for (const game of ['ARC Raiders', 'NARAKA: BLADEPOINT']) {
          if (now() < retryAfter) break;
          // Seed the per-game cache with a representative duration cohort while
          // retaining raw, duration-stamped examples for later target matching.
          await research({ title: game, privacyStatus: 'public', channelId: channel.id,
            durationSeconds: 15 * 60 });
        }
      } catch (error) {
        await applyCooldown(error);
        logger.warn?.(`SEO market refresh unavailable: ${error.message}`);
      } finally { refreshing = false; }
    });
  }

  return { enabled, research, schedule, resetBackoff: () => { retryAfter = 0; },
    getQuotaBlockedUntil: () => dailyQuotaBlockedUntil };
}

module.exports = { detectGame, durationBand, median, quantile, summarizeMarketSamples, createSeoMarket };
