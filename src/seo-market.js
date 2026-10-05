const { isYouTubeAuthorizationError } = require('./channel-tags');

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

function createSeoMarket({ store, youtube, env = process.env, logger = console, now = Date.now }) {
  const enabled = env.SEO_MARKET_RESEARCH === 'true';
  const hasStore = typeof store.getSeoMarketSnapshot === 'function' &&
    typeof store.saveSeoMarketSnapshot === 'function' &&
    typeof store.getSeoMarketBudget === 'function' && typeof store.saveSeoMarketBudget === 'function';
  let refreshing = false;
  let retryAfter = 0;
  const authCooldownMs = 6 * 60 * 60 * 1000;

  function applyCooldown(error) {
    retryAfter = now() + (isYouTubeAuthorizationError(error) ? authCooldownMs : 5 * 60 * 1000);
  }

  async function research(source) {
    if (!enabled || !hasStore || source?.privacyStatus !== 'public' ||
        typeof youtube.recentGameVideos !== 'function' || now() < retryAfter) return null;
    const game = detectGame(source);
    if (!game) return null;
    const cached = await store.getSeoMarketSnapshot(game);
    if (cached && now() - Date.parse(cached.observedAt) < 24 * 60 * 60 * 1000) {
      return cached.samples?.length ? cached : null;
    }
    const today = new Date(now()).toISOString().slice(0, 10);
    const budget = await store.getSeoMarketBudget();
    const used = budget?.date === today ? budget.used || 0 : 0;
    if (used >= 3) return null;
    await store.saveSeoMarketBudget({ date: today, used: used + 1 });
    try {
      const examples = await youtube.recentGameVideos(game);
      const samples = examples.filter((item) => item.channelId !== source.channelId).slice(0, 5)
        .map(({ id, title, publishedAt, viewCount, estimatedViewsPerDay }) =>
          ({ id, title, publishedAt, viewCount, estimatedViewsPerDay }));
      const snapshot = { game, query: `${game} gameplay`, observedAt: new Date(now()).toISOString(),
        windowDays: 7, samples };
      await store.saveSeoMarketSnapshot(game, snapshot);
      retryAfter = 0;
      logger.info?.(`SEO market snapshot ${game}: ${samples.length} recent public video examples; ` +
        JSON.stringify(samples.slice(0, 2)));
      return samples.length ? snapshot : null;
    } catch (error) {
      applyCooldown(error);
      logger.warn?.(`SEO market sample ${game} unavailable: ${error.message}`);
      return null;
    }
  }

  function schedule() {
    if (!enabled || refreshing || now() < retryAfter) return;
    refreshing = true;
    setImmediate(async () => {
      try {
        if (!await youtube.isConnected()) return;
        const channel = await youtube.ownedChannel();
        await youtube.assertTargetChannel(channel.id);
        for (const game of ['ARC Raiders', 'NARAKA: BLADEPOINT']) {
          if (now() < retryAfter) break;
          await research({ title: game, privacyStatus: 'public', channelId: channel.id });
        }
      } catch (error) {
        applyCooldown(error);
        logger.warn?.(`SEO market refresh unavailable: ${error.message}`);
      } finally { refreshing = false; }
    });
  }

  return { enabled, research, schedule, resetBackoff: () => { retryAfter = 0; } };
}

module.exports = { detectGame, createSeoMarket };
