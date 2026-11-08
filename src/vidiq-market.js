'use strict';

const crypto = require('node:crypto');
const { createVidiqMcpClient } = require('./vidiq-mcp');
const { detectGame } = require('./seo-market');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHANNEL_ID = 'UC8C-RJ78JgAYHcNzptz2r7w';
const DEFAULT_ACCOUNT_EMAIL = 'superlegit529@gmail.com';
const DEFAULT_CREDIT_COST = 5;
const DEFAULT_WEEKLY_CREDIT_LIMIT = 5;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you',
  'game', 'gameplay', 'video', 'live', 'stream', 'clip', 'short', 'shorts', 'highlights', 'official']);

function normalizedText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isoWeekKey(now) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function parseMonthlyRange(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const min = parseNullableNumber(value.min);
    const max = parseNullableNumber(value.max);
    const display = typeof value.display === 'string' ? value.display.trim() : '';
    const invalidBounds = min !== null && min < 0 || max !== null && max < 0 ||
      min !== null && max !== null && min > max;
    if (invalidBounds) return { min: null, max: null, kind: 'unknown', uncertainty: 'invalid_provider_range',
      display: display.slice(0, 40) || null };
    if (min !== null || max !== null) return { min, max,
      kind: 'interval', uncertainty: 'provider_bounds',
      display: String(display || (min === max ? min : `${min ?? '≥0'}–${max ?? 'unknown'}`)).slice(0, 40) };
    return { min: null, max: null, kind: 'unknown', uncertainty: 'not_provided',
      display: display.slice(0, 40) || null };
  }
  const display = String(value ?? '').trim();
  const text = display;
  if (!text || /^(null|none|unknown|n\/?a|—|-)$/i.test(text)) {
    return { min: null, max: null, kind: 'unknown', uncertainty: 'not_provided', display: display || null };
  }
  const numberPattern = '(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d+)?';
  const range = text.match(new RegExp(`^(${numberPattern})\\s*[-–]\\s*(${numberPattern})$`));
  if (range) {
    const min = Number(range[1].replace(/,/g, ''));
    const max = Number(range[2].replace(/,/g, ''));
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) return { min, max,
      kind: 'interval', uncertainty: 'provider_bounds', display: display.slice(0, 40) };
    return { min: null, max: null, kind: 'unknown', uncertainty: 'invalid_provider_range', display: display.slice(0, 40) };
  }
  const match = text.match(new RegExp(`^([<>])?\\s*(${numberPattern})\\s*([KMB])?$`, 'i'));
  if (!match) return { min: null, max: null, kind: 'unknown',
    uncertainty: 'invalid_provider_range', display: display.slice(0, 40) };
  const multiplier = ({ K: 1e3, M: 1e6, B: 1e9 })[String(match[3] || '').toUpperCase()] || 1;
  const amount = Number(match[2].replace(/,/g, '')) * multiplier;
  if (!Number.isFinite(amount) || amount < 0) {
    return { min: null, max: null, kind: 'unknown', uncertainty: 'invalid_provider_range', display: display.slice(0, 40) };
  }
  if (match[1] === '<') {
    if (amount <= 0) return { min: null, max: null, kind: 'unknown', uncertainty: 'invalid_provider_range', display: display.slice(0, 40) };
    return { min: 0, max: Math.ceil(amount) - 1, kind: 'interval', uncertainty: 'provider_bounds', display: display.slice(0, 40) };
  }
  if (match[1] === '>') return { min: Math.floor(amount) + 1, max: null,
    kind: 'interval', uncertainty: 'provider_bounds', display: display.slice(0, 40) };
  return { min: amount, max: amount, kind: 'point_estimate', uncertainty: 'not_provided', display: display.slice(0, 40) };
}

function parseNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || /^(null|none|unknown|n\/?a|—|-)$/i.test(text)) return null;
  const numeric = text.replace(/%$/, '');
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(numeric)) return null;
  const number = Number(numeric.replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function parseNonnegativeNumber(value) {
  const number = parseNullableNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function parseVidIQScore(value) {
  const number = parseNullableNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function parseGrowth(value) {
  if (value === null || value === undefined || /^(null|none|unknown|n\/?a|—|-)$/i.test(String(value).trim())) return null;
  const match = String(value).trim().match(/^([+-]?\d+(?:\.\d+)?)%?$/);
  if (!match) return null;
  const growth = Number(match[1]);
  return Number.isFinite(growth) ? growth : null;
}

function parseMarkdownTables(text) {
  const sections = [];
  const lines = String(text || '').split(/\r?\n/);
  let section = '';
  let headers = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(seedKeyword|relatedKeywords)\b/i);
    if (heading) { section = heading[1].toLowerCase(); headers = null; continue; }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    if (!headers) { headers = cells.map((cell) => normalizedText(cell).replace(/ /g, '')); continue; }
    if (!section || cells.length !== headers.length) continue;
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
    const keyword = row.keyword || row.term;
    if (!keyword || keyword.length > 140) continue;
    sections.push({ section, keyword: keyword.trim(), volumeScore: parseVidIQScore(row.volume),
      competitionScore: parseVidIQScore(row.competition), overallScore: parseVidIQScore(row.overall),
      estimatedMonthlySearch: parseMonthlyRange(row.estimatedmonthlysearch),
      searchDemandGrowthPct: parseGrowth(row.searchdemandgrowthpct),
      countryVolume: parseNonnegativeNumber(row.countryvolume), topMarkets: String(row.topmarketstop3 || row.topmarkets || '').slice(0, 160) });
  }
  return sections;
}

function unwrapToolResult(result) {
  if (result?.isError) throw new Error('VidIQ tool returned an error result');
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object') return structured;
  const texts = (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text);
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* VidIQ may format keyword results as Markdown tables. */ }
  }
  return { text: texts.join('\n') };
}

function normalizeKeywordRow(row, section = null) {
  if (!row || typeof row !== 'object') return null;
  const keyword = String(row.keyword ?? row.term ?? '').trim();
  if (!keyword || keyword.length > 140) return null;
  return { section: String(row.section || section || 'relatedkeywords').toLowerCase(), keyword,
    volumeScore: parseVidIQScore(row.volumeScore ?? row.volume),
    competitionScore: parseVidIQScore(row.competitionScore ?? row.competition),
    overallScore: parseVidIQScore(row.overallScore ?? row.overall),
    estimatedMonthlySearch: parseMonthlyRange(row.estimatedMonthlySearch ?? row.estimated_monthly_search),
    searchDemandGrowthPct: parseGrowth(row.searchDemandGrowthPct ?? row.search_demand_growth_pct),
    countryVolume: parseNonnegativeNumber(row.countryVolume ?? row.country_volume),
    topMarkets: String(row.topMarkets ?? row.topMarketsTop3 ?? row.top_markets ?? '').slice(0, 160) };
}

function extractRows(result) {
  const data = unwrapToolResult(result);
  const candidates = [data, data?.data, data?.result, data?.data?.result].filter((item) => item && typeof item === 'object');
  const structured = candidates.find((item) => Array.isArray(item.keywords) ||
    Array.isArray(item.relatedKeywords) || Array.isArray(item.seedKeywords));
  if (structured && Array.isArray(structured.keywords)) return structured.keywords.map((row) => normalizeKeywordRow(row)).filter(Boolean);
  if (structured && (Array.isArray(structured.relatedKeywords) || Array.isArray(structured.seedKeywords))) {
    return [ ...(structured.seedKeywords || []).map((row) => normalizeKeywordRow(row, 'seedkeyword')),
      ...(structured.relatedKeywords || []).map((row) => normalizeKeywordRow(row, 'relatedkeywords')) ].filter(Boolean);
  }
  return parseMarkdownTables(data.text || '');
}

function hasExactPhrase(text, phrase) {
  const haystack = ` ${normalizedText(text)} `;
  const needle = ` ${normalizedText(phrase)} `;
  return needle.length > 2 && haystack.includes(needle);
}

function addSupport(rows, source, context, _analysis, _game) {
  const fields = [
    ['source_title', source?.title], ['source_description', source?.description],
    ['owner_primary_keyword', context?.primaryKeyword], ['owner_topic', context?.topic],
    ['owner_takeaways', context?.takeaways], ['owner_video_type', context?.videoType]
  ].filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([name, value]) => ({ name, value }));
  return rows.map((row) => {
    const supportSources = fields.filter((field) => hasExactPhrase(field.value, row.keyword)).map((field) => field.name);
    return { ...row, sourceSupport: supportSources.length ? 'candidate_phrase_overlap' : 'unverified_phrase',
      sourceOwnerTokenOverlap: supportSources.length > 0,
      supportSources, usedForPackaging: false };
  });
}

function extractAccount(result) {
  const data = unwrapToolResult(result);
  if (Array.isArray(data.channels)) return { channels: data.channels,
    authenticatedAs: typeof data.authenticatedAs === 'string' ? data.authenticatedAs : null };
  return { channels: [], authenticatedAs: null };
}

function extractBalance(result) {
  const data = unwrapToolResult(result);
  if (data.type === 'unlimited') return { type: 'unlimited', totalCredits: null };
  if (data.type !== 'limited') return { type: 'unknown', totalCredits: null };
  const totalCredits = parseNullableNumber(data.totalCredits);
  return { type: 'limited', totalCredits: Number.isSafeInteger(totalCredits) ? totalCredits : null };
}

function snapshotKey(query) {
  return `vidiq_market_${crypto.createHash('sha256').update(normalizedText(query)).digest('hex').slice(0, 24)}`;
}

function createVidIQMarket({ store, env = process.env, logger = console, now = Date.now,
  clientFactory = createVidiqMcpClient } = {}) {
  const enabled = env.VIDIQ_MARKET_RESEARCH === 'true';
  const apiKey = env.VIDIQ_MCP_API_KEY;
  const endpoint = env.VIDIQ_MCP_URL || 'https://mcp.vidiq.com/mcp';
  // This integration is deliberately pinned to AmaanaYT; environment overrides must not
  // accidentally make the SEO worker research Sweatyclanker or another channel.
  const channelId = DEFAULT_CHANNEL_ID;
  const expectedEmail = DEFAULT_ACCOUNT_EMAIL;
  const configuredLimit = Number(env.VIDIQ_WEEKLY_CREDIT_LIMIT);
  const weeklyCreditLimit = configuredLimit === 0 ? 0 : DEFAULT_WEEKLY_CREDIT_LIMIT;
  const cacheTtlMs = 7 * DAY_MS;
  const hasStore = ['getVidIQMarketSnapshot', 'saveVidIQMarketSnapshot', 'getVidIQResearchBudget',
    'reserveVidIQResearchSlot'].every((method) => typeof store?.[method] === 'function');
  const integrationEnabled = Boolean(enabled && apiKey && hasStore && weeklyCreditLimit >= DEFAULT_CREDIT_COST);
  let lastReason = !enabled ? 'disabled_by_configuration' : !apiKey ? 'missing_api_key' :
    !hasStore ? 'market_store_unavailable' : weeklyCreditLimit < DEFAULT_CREDIT_COST ? 'weekly_credit_budget_disabled' : null;
  let lastError = null;
  let client = null;
  let identityRetryAfter = 0;
  let authorizedOwnerVerified = false;
  let identityVerifiedAt = null;
  let lastSharedBalance = null;
  let lastSharedBalanceType = null;
  let lastBalanceCheckedAt = null;

  async function research(source, context = {}, analysis = null) {
    if (!integrationEnabled) return null;
    // VidIQ may only receive public channel content; private/unlisted upload metadata stays local.
    if (source?.privacyStatus !== 'public') {
      lastReason = 'nonpublic_video_excluded';
      return null;
    }
    const game = detectGame(source);
    const contextGame = detectGame({ title: `${context?.primaryKeyword || ''} ${context?.topic || ''}` });
    if (contextGame && game && contextGame !== game) {
      lastReason = 'game_context_mismatch';
      return null;
    }
    if (!game) {
      lastReason = 'unrecognized_game';
      return null;
    }
    if (source?.channelId !== channelId) {
      lastReason = 'channel_mismatch';
      return null;
    }
    const topic = String(context?.primaryKeyword || '').trim().slice(0, 60);
    const query = `${game}${topic && normalizedText(topic).split(' ').length <= 5 ? ` ${topic}` : ''} gameplay`.slice(0, 100);
    const key = snapshotKey(query);
    let cached;
    try { cached = await store.getVidIQMarketSnapshot(key); }
    catch (error) {
      lastReason = 'market_snapshot_store_unavailable';
      lastError = String(error.message || 'VidIQ market snapshot store unavailable').slice(0, 180);
      return null;
    }
    if (cached && now() - Date.parse(cached.observedAt) >= 0 && now() - Date.parse(cached.observedAt) < cacheTtlMs) {
      lastReason = 'fresh_cached_snapshot';
      const rows = Array.isArray(cached.rows) ? cached.rows.map((row) => {
        const { sourceSupport, sourceOwnerTokenOverlap, supportSources, usedForPackaging, ...rawRow } = row;
        return rawRow;
      }) : [];
      return { ...cached, rows: addSupport(rows, source, context, null, game) };
    }
    const week = isoWeekKey(now());
    let existingBudget;
    try { existingBudget = await store.getVidIQResearchBudget(); }
    catch (error) {
      lastReason = 'weekly_budget_store_unavailable';
      lastError = String(error.message || 'VidIQ budget store unavailable').slice(0, 180);
      return null;
    }
    const usedCredits = existingBudget?.period === week && Number.isSafeInteger(existingBudget.creditsUsed) &&
      existingBudget.creditsUsed >= 0 ? existingBudget.creditsUsed : 0;
    const lastReservedAtMs = Date.parse(existingBudget?.lastReservedAt || '');
    if (Number.isFinite(lastReservedAtMs) && now() - lastReservedAtMs < cacheTtlMs) {
      lastReason = 'rolling_credit_cooldown';
      return null;
    }
    if (usedCredits + DEFAULT_CREDIT_COST > weeklyCreditLimit) {
      lastReason = 'weekly_credit_budget_exhausted';
      return null;
    }
    if (now() < identityRetryAfter) {
      lastReason = 'identity_check_cooldown';
      return null;
    }
    client ||= clientFactory({ apiKey, endpoint });
    let reservationMade = false;
    try {
      const account = extractAccount(await client.callReadOnlyTool('vidiq_user_channels'));
      if (!account.channels.some((item) => item?.channelId === channelId)) {
        authorizedOwnerVerified = false;
        lastReason = 'authorized_channel_not_found';
        lastError = null;
        identityRetryAfter = now() + 6 * 60 * 60 * 1000;
        logger.warn?.('VidIQ research held: configured AmaanaYT channel is not in the authorized VidIQ channel list');
        return null;
      }
      if (account.authenticatedAs?.trim().toLowerCase() !== expectedEmail) {
        authorizedOwnerVerified = false;
        lastReason = account.authenticatedAs ? 'authenticated_account_mismatch' : 'authenticated_account_unverified';
        lastError = null;
        identityRetryAfter = now() + 6 * 60 * 60 * 1000;
        logger.warn?.('VidIQ research held: authenticated account does not match the configured AmaanaYT owner');
        return null;
      }
      authorizedOwnerVerified = true;
      identityVerifiedAt = new Date(now()).toISOString();
      identityRetryAfter = 0;
      const balance = extractBalance(await client.callReadOnlyTool('vidiq_balance'));
      lastBalanceCheckedAt = new Date(now()).toISOString();
      lastSharedBalanceType = balance.type;
      lastSharedBalance = balance.type === 'unlimited' ? null : balance.totalCredits;
      if (balance.type !== 'unlimited' && !Number.isSafeInteger(balance.totalCredits)) {
        lastReason = 'shared_balance_unavailable';
        return null;
      }
      if (balance.type === 'limited' && balance.totalCredits < DEFAULT_CREDIT_COST) {
        lastReason = 'shared_balance_below_call_cost';
        return null;
      }
      const reservationTime = now();
      const reservationWeek = isoWeekKey(reservationTime);
      const reservation = await store.reserveVidIQResearchSlot(reservationWeek, DEFAULT_CREDIT_COST,
        weeklyCreditLimit, reservationTime);
      if (!reservation?.allowed) {
        lastReason = reservation?.reason === 'rolling_window'
          ? 'rolling_credit_cooldown' : 'weekly_credit_budget_exhausted';
        return null;
      }
      reservationMade = true;
      const result = await client.callReadOnlyTool('vidiq_keyword_research', {
        keyword: query, country: 'US', language: 'en', mode: 'research', limit: 12, includeRelated: true,
        userGoal: 'Prepare accurate search packaging for verified AmaanaYT gameplay; market suggestions must not add unsupported footage claims.'
      });
      const rows = extractRows(result).slice(0, 16);
      if (!rows.length) throw new Error('VidIQ returned no parseable keyword evidence');
      const groundedRows = addSupport(rows, source, context, null, game);
      const snapshot = { source: 'vidIQ_MCP_read_only', channelId, game, query,
        observedAt: new Date(now()).toISOString(), freshUntil: new Date(now() + cacheTtlMs).toISOString(),
        costCredits: DEFAULT_CREDIT_COST, budgetPeriod: reservationWeek, estimatedSearchMetrics: true,
        rows, policy: 'read_only_directional_estimates_candidate_phrase_overlap_only' };
      await store.saveVidIQMarketSnapshot(key, snapshot);
      lastReason = 'fresh_research_saved';
      lastError = null;
      logger.info?.(`VidIQ research saved for ${game}; rows=${rows.length}; cacheDays=7; ` +
        `weeklyCredits=${reservation.usedCredits}/${weeklyCreditLimit}; phraseOverlap=${groundedRows.filter((row) =>
          row.sourceOwnerTokenOverlap === true).length}`);
      return { ...snapshot, rows: groundedRows };
    } catch (error) {
      lastReason = reservationMade ? 'research_failed_budget_slot_consumed' : 'research_failed_before_reservation';
      lastError = String(error.message || 'VidIQ research failed').slice(0, 180);
      logger.warn?.(`VidIQ market research failed for ${game}: ${lastError}`);
      return null;
    }
  }

  async function status() {
    const budget = hasStore ? await store.getVidIQResearchBudget() : null;
    const currentWeek = isoWeekKey(now());
    const lastReservedAtMs = Date.parse(budget?.lastReservedAt || '');
    const nextResearchEligibleAt = Number.isFinite(lastReservedAtMs)
      ? new Date(lastReservedAtMs + cacheTtlMs).toISOString() : null;
    return { enabled: integrationEnabled, configured: Boolean(apiKey),
      endpoint, channelId, authorizedOwnerVerified, identityVerifiedAt,
      weeklyCreditLimit, researchCreditCost: DEFAULT_CREDIT_COST, cacheDays: 7,
      budgetPeriod: currentWeek, storedBudgetPeriod: budget?.period || null,
      creditsReservedThisWeek: budget?.period === currentWeek ? budget?.creditsUsed || 0 : 0,
      lastReservedAt: budget?.lastReservedAt || null,
      nextResearchEligibleAt: nextResearchEligibleAt && Date.parse(nextResearchEligibleAt) > now()
        ? nextResearchEligibleAt : null,
      lastSharedBalanceType, lastSharedBalance, lastBalanceCheckedAt, lastReason, lastError };
  }

  return { enabled: integrationEnabled, research, status };
}

module.exports = { DAY_MS, DEFAULT_CHANNEL_ID, DEFAULT_ACCOUNT_EMAIL, DEFAULT_CREDIT_COST,
  DEFAULT_WEEKLY_CREDIT_LIMIT, normalizedText, isoWeekKey, parseMonthlyRange, parseNullableNumber,
  parseNonnegativeNumber, parseVidIQScore, parseGrowth, parseMarkdownTables, unwrapToolResult, extractRows, addSupport, extractAccount,
  extractBalance, hasExactPhrase, snapshotKey, createVidIQMarket };
