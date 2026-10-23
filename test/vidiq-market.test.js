'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVidIQMarket, isoWeekKey, parseMonthlyRange, parseMarkdownTables,
  extractRows, addSupport, snapshotKey, parseNullableNumber, parseGrowth } = require('../src/vidiq-market');
const { addVidIQReviewGate, VIDIQ_OWNER_REVIEW_REASON } = require('../src/seo-worker');

const channelId = 'UC8C-RJ78JgAYHcNzptz2r7w';
const source = { channelId, title: 'Mortal Kombat 11 Sheeva Stomp gameplay',
  description: 'Sheeva gameplay from the Mortal Kombat 11 match.', privacyStatus: 'public' };
const markdown = `## Keyword research — mode: research · country: US

### seedKeyword (1)
| keyword | volume | competition | overall | estimatedMonthlySearch | searchDemandGrowthPct | countryVolume | topMarkets (top 3) |
|---|---|---|---|---|---|---|---|
| mortal kombat 11 sheeva stomp gameplay | 0 | 14 | 34 | <750 | null | null | none |
### relatedKeywords (2)
| keyword | volume | competition | overall | estimatedMonthlySearch | searchDemandGrowthPct | countryVolume | topMarkets (top 3) |
|---|---|---|---|---|---|---|---|
| mk11 | 67 | 62 | 56 | 30502 | +18.9% | 13865 | US 45% |
| mortal kombat 11 aftermath | 58 | 59 | 52 | 8284 | +6.9% | null | none |
`;

function makeStore() {
  const snapshots = new Map();
  const budgets = new Map();
  return {
    snapshots,
    budgets,
    async getVidIQMarketSnapshot(key) { return snapshots.get(key) || null; },
    async saveVidIQMarketSnapshot(key, value) { snapshots.set(key, structuredClone(value)); },
    async getVidIQResearchBudget() { return budgets.get('current') || null; },
    async reserveVidIQResearchSlot(period, cost, limit, nowMs = Date.now()) {
      const existing = budgets.get('current');
      const lastReservedAt = Date.parse(existing?.lastReservedAt || '');
      if (Number.isFinite(lastReservedAt) && nowMs - lastReservedAt < 7 * 24 * 60 * 60 * 1000) {
        return { allowed: false, reason: 'rolling_window', period, lastReservedAt: existing.lastReservedAt };
      }
      const used = existing?.period === period ? existing.creditsUsed : 0;
      if (used + cost > limit) return { allowed: false, usedCredits: used, limitCredits: limit };
      const next = { period, creditsUsed: used + cost, lastReservedAt: new Date(nowMs).toISOString() };
      budgets.set('current', next);
      return { allowed: true, usedCredits: next.creditsUsed, limitCredits: limit };
    }
  };
}

test('VidIQ parser preserves bounded search estimates and true numeric zero scores', () => {
  assert.deepEqual(parseMonthlyRange('<750'), { min: 0, max: 749,
    kind: 'interval', uncertainty: 'provider_bounds', display: '<750' });
  assert.deepEqual(parseMonthlyRange('>750.5'), { min: 751, max: null,
    kind: 'interval', uncertainty: 'provider_bounds', display: '>750.5' });
  assert.deepEqual(parseMonthlyRange('30,502'), { min: 30502, max: 30502,
    kind: 'point_estimate', uncertainty: 'not_provided', display: '30,502' });
  assert.equal(parseMonthlyRange('null').min, null);
  assert.deepEqual(parseMonthlyRange('<0'), { min: null, max: null,
    kind: 'unknown', uncertainty: 'invalid_provider_range', display: '<0' });
  assert.deepEqual(parseMonthlyRange({ min: 100, max: 10, display: '100–10' }),
    { min: null, max: null, kind: 'unknown', uncertainty: 'invalid_provider_range', display: '100–10' });
  assert.deepEqual(parseMonthlyRange({ min: null, max: null, display: '<750' }),
    { min: null, max: null, kind: 'unknown', uncertainty: 'not_provided', display: '<750' });
  assert.equal(extractRows({ structuredContent: { keywords: [
    { keyword: '  MK11 ', estimatedMonthlySearch: '<750', volumeScore: '' },
    { keyword: '', volumeScore: 12 }
  ] } })[0].estimatedMonthlySearch.max, 749);
  assert.equal(extractRows({ structuredContent: { keywords: [
    { keyword: 'MK11', volumeScore: '' }
  ] } })[0].volumeScore, null);
  assert.equal(parseNullableNumber('1,2'), null);
  assert.equal(parseNullableNumber('1,234.5'), 1234.5);
  assert.equal(parseGrowth('9'.repeat(500)), null);
  assert.deepEqual(extractRows({ structuredContent: { result: { keywords: [{ keyword: 'nested' }] } } })
    .map((row) => row.keyword), ['nested']);
  const rows = parseMarkdownTables(markdown);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].volumeScore, 0);
  assert.equal(rows[0].estimatedMonthlySearch.max, 749);
  assert.equal(rows[1].searchDemandGrowthPct, 18.9);
  assert.equal(isoWeekKey(Date.parse('2026-10-23T00:00:00Z')), '2026-W43');
  assert.match(snapshotKey('Mortal Kombat 11 gameplay'), /^vidiq_market_[a-f0-9]{24}$/);
});

test('VidIQ market evidence is owner-channel matched, supported, cached, and weekly credit capped', async () => {
  const store = makeStore();
  const calls = [];
  const clientFactory = () => ({ async callReadOnlyTool(name, args) {
    calls.push({ name, args });
    if (name === 'vidiq_user_channels') return { content: [{ type: 'text', text: JSON.stringify({
      authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
    }) }] };
    if (name === 'vidiq_balance') return { content: [{ type: 'text', text: JSON.stringify({
      type: 'limited', totalCredits: 30
    }) }] };
    return { content: [{ type: 'text', text: markdown }] };
  } });
  const now = () => Date.parse('2026-10-23T16:00:00Z');
  const research = createVidIQMarket({ store, now, clientFactory,
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key', VIDIQ_WEEKLY_CREDIT_LIMIT: '150' } });
  const first = await research.research(source, { primaryKeyword: 'Sheeva Stomp' }, null);
  assert.equal(first.source, 'vidIQ_MCP_read_only');
  assert.equal(first.rows.find((row) => row.keyword === 'mk11').estimatedMonthlySearch.min, 30502);
  assert.equal(first.rows.find((row) => row.keyword === 'mk11').searchDemandGrowthPct, 18.9);
  assert.equal(first.rows.find((row) => row.keyword === 'mortal kombat 11 aftermath').sourceSupport, 'unverified_phrase');
  assert.equal(calls.filter((call) => call.name === 'vidiq_keyword_research').length, 1);
  assert.equal((await research.research(source, { primaryKeyword: 'Sheeva Stomp' }, null)).observedAt, first.observedAt);
  assert.equal(calls.filter((call) => call.name === 'vidiq_keyword_research').length, 1, 'fresh query is served from its seven-day cache');
  assert.equal((await research.status()).creditsReservedThisWeek, 5);
  assert.equal((await research.status()).weeklyCreditLimit, 5, 'configuration cannot raise the hard five-credit cap');
  const wrongChannel = await research.research({ ...source, channelId: 'other' }, {}, null);
  assert.equal(wrongChannel, null);
  assert.equal(calls.length, 3, 'a non-Amaana channel makes no VidIQ request');
  const cacheWithDifferentVideo = await research.research({ ...source, title: 'Mortal Kombat 11 Scorpion gameplay',
    description: 'Scorpion round and match footage.' }, { primaryKeyword: 'Sheeva Stomp' }, null);
  assert.equal(cacheWithDifferentVideo.rows.find((row) => row.keyword === 'mortal kombat 11 sheeva stomp gameplay').sourceSupport,
    'unverified_phrase', 'cached raw VidIQ rows must be re-grounded for each video');
});

test('VidIQ receives no private or unlisted video context and can be disabled with a zero cap', async () => {
  let calls = 0;
  const store = makeStore();
  const clientFactory = () => ({ async callReadOnlyTool(name) {
    calls += 1;
    if (name === 'vidiq_user_channels') return { content: [{ type: 'text', text: JSON.stringify({
      authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
    }) }] };
    return { content: [{ type: 'text', text: markdown }] };
  } });
  const enabled = createVidIQMarket({ store, clientFactory,
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' } });
  assert.equal(await enabled.research({ ...source, privacyStatus: 'private' }, { primaryKeyword: 'private plan' }), null);
  assert.equal(await enabled.research({ ...source, privacyStatus: 'unlisted' }, { primaryKeyword: 'unlisted plan' }), null);
  assert.equal(calls, 0, 'nonpublic records are not sent to VidIQ, including queries');
  const disabled = createVidIQMarket({ store, clientFactory,
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key', VIDIQ_WEEKLY_CREDIT_LIMIT: '0' } });
  assert.equal(await disabled.research(source), null);
  assert.equal((await disabled.status()).lastReason, 'weekly_credit_budget_disabled');
  assert.equal(calls, 0);
});

test('VidIQ research fails closed for missing key, wrong account, and exhausted weekly credits', async () => {
  const store = makeStore();
  const disabled = createVidIQMarket({ store, env: { VIDIQ_MARKET_RESEARCH: 'true' }, clientFactory: () => {
    throw new Error('must not be called');
  } });
  assert.equal(await disabled.research(source), null);
  assert.equal((await disabled.status()).lastReason, 'missing_api_key');

  let researchCalls = 0;
  const wrongAccount = createVidIQMarket({ store,
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    clientFactory: () => ({ async callReadOnlyTool(name) {
      if (name === 'vidiq_user_channels') return { content: [{ type: 'text', text: JSON.stringify({
        authenticatedAs: 'different@example.com', channels: [{ channelId }]
      }) }] };
      researchCalls += 1;
      return { content: [{ type: 'text', text: markdown }] };
    } }) });
  assert.equal(await wrongAccount.research(source), null);
  assert.equal((await wrongAccount.status()).lastReason, 'authenticated_account_mismatch');
  assert.equal(researchCalls, 0);

  const missingIdentity = createVidIQMarket({ store: makeStore(),
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    clientFactory: () => ({ async callReadOnlyTool(name) {
      if (name === 'vidiq_user_channels') return { structuredContent: { channels: [{ channelId }] } };
      throw new Error('must not be called');
    } }) });
  assert.equal(await missingIdentity.research(source), null);
  assert.equal((await missingIdentity.status()).lastReason, 'authenticated_account_unverified');

  const budgetStore = makeStore();
  budgetStore.budgets.set('current', { period: '2026-W43', creditsUsed: 5 });
  const budgetCapped = createVidIQMarket({ store: budgetStore,
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    now: () => Date.parse('2026-10-23T16:00:00Z'),
    clientFactory: () => ({ async callReadOnlyTool(name) {
      if (name === 'vidiq_user_channels') return { content: [{ type: 'text', text: JSON.stringify({
        authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
      }) }] };
      if (name === 'vidiq_balance') return { structuredContent: { type: 'limited', totalCredits: 30 } };
      throw new Error('keyword request must not occur after budget exhaustion');
    } }) });
  assert.equal(await budgetCapped.research(source), null);
  assert.equal((await budgetCapped.status()).lastReason, 'weekly_credit_budget_exhausted');
  assert.equal((await budgetCapped.status()).creditsReservedThisWeek, 5);
});

test('VidIQ errors consume their reservation and do not retry keyword research in the same week', async () => {
  const store = makeStore();
  let keywordCalls = 0;
  const market = createVidIQMarket({ store, now: () => Date.parse('2026-10-23T16:00:00Z'),
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    logger: { warn() {}, info() {} },
    clientFactory: () => ({ async callReadOnlyTool(name) {
      if (name === 'vidiq_user_channels') return { content: [{ type: 'text', text: JSON.stringify({
        authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
      }) }] };
      if (name === 'vidiq_balance') return { structuredContent: { type: 'limited', totalCredits: 30 } };
      keywordCalls += 1;
      throw new Error('temporary timeout');
    } }) });
  assert.equal(await market.research(source), null);
  assert.equal(await market.research(source), null);
  assert.equal(keywordCalls, 1);
  assert.equal((await market.status()).creditsReservedThisWeek, 5);
});

test('shared balance is checked before the paid keyword call and fails closed when unknown or insufficient', async () => {
  for (const totalCredits of [4, null]) {
    const store = makeStore();
    const calls = [];
    const market = createVidIQMarket({ store, now: () => Date.parse('2026-10-23T16:00:00Z'),
      env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
      clientFactory: () => ({ async callReadOnlyTool(name) {
        calls.push(name);
        if (name === 'vidiq_user_channels') return { structuredContent: {
          authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
        } };
        if (name === 'vidiq_balance') return { structuredContent: { type: 'limited', totalCredits } };
        throw new Error('paid request must not run without a confirmed balance of five');
      } }) });
    assert.equal(await market.research(source), null);
    assert.equal(calls.includes('vidiq_keyword_research'), false);
    assert.equal((await market.status()).creditsReservedThisWeek, 0);
    assert.equal((await market.status()).lastReason,
      totalCredits === 4 ? 'shared_balance_below_call_cost' : 'shared_balance_unavailable');
  }
});

test('spent UTC-week budget short-circuits before even free VidIQ identity or balance calls', async () => {
  const store = makeStore();
  store.budgets.set('current', { period: '2026-W43', creditsUsed: 5 });
  let calls = 0;
  const market = createVidIQMarket({ store, now: () => Date.parse('2026-10-23T16:00:00Z'),
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    clientFactory: () => ({ async callReadOnlyTool() { calls += 1; throw new Error('must not call after cap'); } }) });
  assert.equal(await market.research(source), null);
  assert.equal(calls, 0);
  assert.equal((await market.status()).lastReason, 'weekly_credit_budget_exhausted');
});

test('rolling seven-day credit cooldown prevents a double spend at the UTC week boundary', async () => {
  const store = makeStore();
  const calls = [];
  const firstTime = Date.parse('2026-10-25T23:59:00Z');
  const currentTime = { value: firstTime };
  const market = createVidIQMarket({ store, now: () => currentTime.value,
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    clientFactory: () => ({ async callReadOnlyTool(name) {
      calls.push(name);
      if (name === 'vidiq_user_channels') return { structuredContent: {
        authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
      } };
      if (name === 'vidiq_balance') return { structuredContent: { type: 'limited', totalCredits: 30 } };
      return { content: [{ type: 'text', text: markdown }] };
    } }) });
  assert.equal((await market.research(source, { primaryKeyword: 'Sheeva Stomp' })).budgetPeriod, '2026-W43');
  assert.equal(calls.filter((name) => name === 'vidiq_keyword_research').length, 1);
  currentTime.value = Date.parse('2026-10-26T00:01:00Z');
  assert.equal(await market.research(source, { primaryKeyword: 'Sheeva pressure' }), null,
    'a new UTC week must not create a second paid request two minutes later');
  assert.equal(calls.filter((name) => name === 'vidiq_keyword_research').length, 1);
  assert.equal((await market.status()).lastReason, 'rolling_credit_cooldown');
  assert.equal((await market.status()).creditsReservedThisWeek, 0);
});

test('balance failure does not reserve a paid credit or report a consumed slot', async () => {
  const store = makeStore();
  const market = createVidIQMarket({ store, now: () => Date.parse('2026-10-23T16:00:00Z'),
    env: { VIDIQ_MARKET_RESEARCH: 'true', VIDIQ_MCP_API_KEY: 'key' },
    logger: { warn() {}, info() {} },
    clientFactory: () => ({ async callReadOnlyTool(name) {
      if (name === 'vidiq_user_channels') return { structuredContent: {
        authenticatedAs: 'superlegit529@gmail.com', channels: [{ channelId }]
      } };
      if (name === 'vidiq_balance') throw new Error('balance service unavailable');
      throw new Error('paid research must not run');
    } }) });
  assert.equal(await market.research(source), null);
  assert.equal((await market.status()).creditsReservedThisWeek, 0);
  assert.equal((await market.status()).lastReason, 'research_failed_before_reservation');
  assert.equal((await market.status()).lastError, 'balance service unavailable');
});

test('keyword support requires the actual source or owner context and never becomes automatic metadata', () => {
  const rows = extractRows({ content: [{ type: 'text', text: markdown }] });
  const tagged = addSupport(rows, source, { takeaways: 'Sheeva Stomp' }, null, 'Mortal Kombat');
  assert.equal(tagged.find((row) => row.keyword === 'mortal kombat 11 sheeva stomp gameplay').sourceSupport,
    'candidate_phrase_overlap');
  assert.equal(tagged.find((row) => row.keyword === 'mortal kombat 11 sheeva stomp gameplay').sourceOwnerTokenOverlap, true);
  assert.equal(tagged.find((row) => row.keyword === 'mortal kombat 11 aftermath').sourceSupport,
    'unverified_phrase');
  assert.ok(tagged.every((row) => row.usedForPackaging === false));
});

test('worker only holds packages when a new, source-overlapping market phrase is actually used', () => {
  const generated = { missingEvidence: [], evidence: { videoAnalysis: true },
    primaryKeyword: 'Mortal Kombat', titles: { hybrid: ['Mortal Kombat gameplay guide'] },
    description: 'Mortal Kombat gameplay guide', tags: ['Mortal Kombat'] };
  const evidence = { observedAt: '2026-10-23T16:00:00Z', query: 'Mortal Kombat gameplay',
    sourceTitle: 'Mortal Kombat 11 match', sourceDescription: 'The footage description says Mortal Kombat gameplay.',
    ownerPrimaryKeyword: 'Mortal Kombat',
    rows: [{ keyword: 'Mortal Kombat gameplay', sourceSupport: 'candidate_phrase_overlap', sourceOwnerTokenOverlap: true },
      { keyword: 'unverified tournament final', sourceSupport: 'unverified_phrase', sourceOwnerTokenOverlap: false }] };
  const gated = addVidIQReviewGate(generated, evidence);
  assert.ok(gated.missingEvidence.includes(VIDIQ_OWNER_REVIEW_REASON));
  assert.equal(gated.evidence.vidiqQuery, 'Mortal Kombat gameplay');
  assert.equal(gated.evidence.vidiqRows.length, 1,
    'unverified phrases are excluded from the shared model, gate, and audit candidate set');
  assert.equal(gated.evidence.vidiqRows[0].usedForPackaging, true);
  assert.equal(addVidIQReviewGate({ ...generated, titles: { hybrid: ['Mortal Kombat gameplay'] } },
    { ...evidence, sourceTitle: 'Mortal Kombat gameplay' }).missingEvidence.includes(VIDIQ_OWNER_REVIEW_REASON), false,
  'already source-grounded wording should not block an otherwise eligible package');
  const onlyUnusedAlternative = addVidIQReviewGate({ ...generated,
    titles: { hybrid: ['Mortal Kombat 11 match', 'Mortal Kombat gameplay'] } }, evidence);
  assert.equal(onlyUnusedAlternative.missingEvidence.includes(VIDIQ_OWNER_REVIEW_REASON), false,
    'an unused alternative title must not slow the automatic publishing path');
  assert.equal(addVidIQReviewGate(generated, null), generated);
});
