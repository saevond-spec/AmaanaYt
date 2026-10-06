const crypto = require('crypto');
const { Pool } = require('pg');
const { prioritizeSeoAutoCandidates } = require('./seo-priority');
const SEO_AUTOPILOT_VERSION = require('./seo-autopilot-version');

function databaseConnectionString(value, production = false) {
  if (!production || !value) return value;
  const url = new URL(value);
  // Keep older deployed URLs from using pg's deprecated sslmode=require alias.
  // The DATABASE_URL should be updated to sslmode=verify-full as well.
  if (!url.searchParams.has('sslmode') ||
      url.searchParams.get('sslmode') === 'require' && url.searchParams.get('uselibpqcompat') !== 'true') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}

const pool = new Pool({
  connectionString: databaseConnectionString(process.env.DATABASE_URL, process.env.NODE_ENV === 'production'),
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

let initialized;

function init() {
  if (!initialized) {
    initialized = pool.query(`
      CREATE TABLE IF NOT EXISTS amaana_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS amaana_drafts (
        id UUID PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS amaana_seo_packages (
        video_id TEXT PRIMARY KEY,
        source JSONB NOT NULL,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        package JSONB,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        claim_token UUID,
        claimed_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        generated_at TIMESTAMPTZ,
        applied JSONB,
        auto_result JSONB,
        playlist_result JSONB,
        next_attempt_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS amaana_seo_packages_status_idx
        ON amaana_seo_packages (status, next_attempt_at, created_at);
      ALTER TABLE amaana_seo_packages ADD COLUMN IF NOT EXISTS applied JSONB;
      ALTER TABLE amaana_seo_packages ADD COLUMN IF NOT EXISTS auto_result JSONB;
      ALTER TABLE amaana_seo_packages ADD COLUMN IF NOT EXISTS playlist_result JSONB;
      CREATE TABLE IF NOT EXISTS amaana_video_analysis (
        video_id TEXT PRIMARY KEY REFERENCES amaana_seo_packages(video_id) ON DELETE CASCADE,
        analysis JSONB NOT NULL,
        model TEXT NOT NULL,
        analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS amaana_google_search_snapshots (
        video_id TEXT NOT NULL REFERENCES amaana_seo_packages(video_id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
        impressions BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
        ctr NUMERIC NOT NULL DEFAULT 0 CHECK (ctr >= 0),
        average_position NUMERIC,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (video_id, period_start, period_end),
        CHECK (period_end >= period_start)
      );
      CREATE INDEX IF NOT EXISTS amaana_google_search_snapshots_recent_idx
        ON amaana_google_search_snapshots (video_id, period_end DESC);
      CREATE TABLE IF NOT EXISTS amaana_youtube_search_snapshots (
        video_id TEXT NOT NULL REFERENCES amaana_seo_packages(video_id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        google_referral_views BIGINT CHECK (google_referral_views >= 0),
        google_referral_complete BOOLEAN NOT NULL DEFAULT FALSE,
        google_detail_rows INTEGER NOT NULL DEFAULT 0 CHECK (google_detail_rows BETWEEN 0 AND 25),
        youtube_search_views BIGINT NOT NULL DEFAULT 0 CHECK (youtube_search_views >= 0),
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (video_id, period_start, period_end),
        CHECK (period_end >= period_start)
      );
      CREATE INDEX IF NOT EXISTS amaana_youtube_search_snapshots_recent_idx
        ON amaana_youtube_search_snapshots (video_id, period_end DESC);
    `);
  }
  return initialized;
}

function key() {
  const value = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  return Buffer.from(value, 'hex');
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decrypt(payload) {
  if (!payload) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

async function saveEncryptedState(stateKey, value) {
  await init();
  if (!/^[a-z0-9_:-]{1,80}$/i.test(stateKey)) throw new Error('Invalid state key');
  await pool.query(
    `INSERT INTO amaana_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [stateKey, JSON.stringify(encrypt(value))]
  );
}

async function getEncryptedState(stateKey) {
  await init();
  if (!/^[a-z0-9_:-]{1,80}$/i.test(stateKey)) throw new Error('Invalid state key');
  const result = await pool.query('SELECT value FROM amaana_state WHERE key = $1', [stateKey]);
  return decrypt(result.rows[0]?.value || null);
}

const saveTokens = (tokens) => saveEncryptedState('youtube_tokens', tokens);
const getTokens = () => getEncryptedState('youtube_tokens');
const saveTwitchTokens = (tokens) => saveEncryptedState('twitch_tokens', tokens);
const getTwitchTokens = () => getEncryptedState('twitch_tokens');
const saveTikTokTokens = (tokens) => saveEncryptedState('tiktok_tokens', tokens);
const getTikTokTokens = () => getEncryptedState('tiktok_tokens');

async function listDrafts() {
  await init();
  const result = await pool.query('SELECT payload FROM amaana_drafts ORDER BY created_at DESC');
  return result.rows.map((row) => row.payload);
}

async function getDraft(id) {
  await init();
  const result = await pool.query('SELECT payload FROM amaana_drafts WHERE id = $1', [id]);
  return result.rows[0]?.payload || null;
}

async function addDraft(draft) {
  await init();
  await pool.query(
    'INSERT INTO amaana_drafts (id, payload) VALUES ($1, $2::jsonb)',
    [draft.id, JSON.stringify(draft)]
  );
  return draft;
}

async function updateDraft(id, patch) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT payload FROM amaana_drafts WHERE id = $1 FOR UPDATE', [id]);
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const updated = { ...result.rows[0].payload, ...patch, updatedAt: new Date().toISOString() };
    await client.query(
      'UPDATE amaana_drafts SET payload = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [id, JSON.stringify(updated)]
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function claimTikTokDelivery(id, automatic) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT payload FROM amaana_drafts WHERE id = $1 FOR UPDATE', [id]);
    const draft = result.rows[0]?.payload;
    if (!draft || draft.sourceType !== 'twitch_highlight_short' || !draft.youtubeVideoId ||
        !draft.tiktokEligible || draft.youtubePrivacyStatus !== 'public' ||
        !Number.isSafeInteger(draft.youtubeViews) || draft.youtubeViews <= 2000 ||
        draft.tiktokPublishId && draft.tiktokStatus !== 'failed' ||
        draft.tiktokStatus === 'preparing' && Date.now() - Date.parse(draft.tiktokQueuedAt || 0) < 15 * 60 * 1000 ||
        automatic && (!draft.tiktokAutoSendConsent || draft.tiktokAttemptedAt)) {
      await client.query('ROLLBACK');
      return null;
    }
    const now = new Date().toISOString();
    const updated = { ...draft, tiktokStatus: 'preparing', tiktokError: null,
      tiktokPublishId: null, tiktokQueuedAt: now, tiktokAttemptedAt: now, updatedAt: now };
    await client.query(
      'UPDATE amaana_drafts SET payload = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [id, JSON.stringify(updated)]
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ping() {
  await init();
  await pool.query('SELECT 1');
}

async function saveSeoSyncState(value) {
  await init();
  await pool.query(`INSERT INTO amaana_state (key, value, updated_at) VALUES ('seo_sync', $1::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(value)]);
}

async function getSeoSyncState() {
  await init();
  const result = await pool.query("SELECT value FROM amaana_state WHERE key = 'seo_sync'");
  return result.rows[0]?.value || { cursor: null, completed: false, enabled: true };
}

async function getSeoMarketSnapshot(game) {
  await init();
  const result = await pool.query('SELECT value FROM amaana_state WHERE key = $1',
    [`seo_market_${game.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`]);
  return result.rows[0]?.value || null;
}

async function saveSeoMarketSnapshot(game, snapshot) {
  await init();
  await pool.query(`INSERT INTO amaana_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  [`seo_market_${game.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, JSON.stringify(snapshot)]);
}

async function getSeoMarketBudget() {
  await init();
  const result = await pool.query("SELECT value FROM amaana_state WHERE key = 'seo_market_budget'");
  return result.rows[0]?.value || null;
}

async function reservePlaylistAutoSlot(privacyStatus, limit, date) {
  await init();
  if (!['public', 'private', 'unlisted'].includes(privacyStatus) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 30 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Invalid automatic playlist quota reservation');
  }
  const key = privacyStatus === 'public' ? 'playlist_auto_public_budget' : 'playlist_auto_private_budget';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO amaana_state (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify({ date, used: 0 })]);
    const selected = await client.query('SELECT value FROM amaana_state WHERE key = $1 FOR UPDATE', [key]);
    const current = selected.rows[0]?.value || {};
    const used = current.date === date && Number.isSafeInteger(current.used) ? current.used : 0;
    if (used >= limit) {
      await client.query('COMMIT');
      return { allowed: false, used, limit };
    }
    const next = { date, used: used + 1 };
    await client.query('UPDATE amaana_state SET value = $2::jsonb, updated_at = NOW() WHERE key = $1',
      [key, JSON.stringify(next)]);
    await client.query('COMMIT');
    return { allowed: true, used: next.used, limit };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function saveSeoMarketBudget(budget) {
  await init();
  await pool.query(`INSERT INTO amaana_state (key, value, updated_at)
    VALUES ('seo_market_budget', $1::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  [JSON.stringify(budget)]);
}

async function upsertSeoVideo(videoId, source) {
  await init();
  // Catalog rescans refresh metadata, while preserving any owner context or completed package.
  await pool.query(`INSERT INTO amaana_seo_packages (video_id, source) VALUES ($1, $2::jsonb)
    ON CONFLICT (video_id) DO UPDATE SET source = EXCLUDED.source, updated_at = NOW()`,
  [videoId, JSON.stringify(source)]);
}

async function getSeoVideo(videoId) {
  await init();
  const result = await pool.query(`SELECT p.video_id AS "videoId", p.source, p.context, p.package, p.status, p.attempts,
    p.error, p.applied, p.auto_result AS "autoResult", p.playlist_result AS "playlistResult",
    p.generated_at AS "generatedAt", p.updated_at AS "updatedAt",
    a.analysis, a.model AS "analysisModel", a.analyzed_at AS "analyzedAt"
    FROM amaana_seo_packages p LEFT JOIN amaana_video_analysis a ON a.video_id = p.video_id
    WHERE p.video_id = $1`, [videoId]);
  return result.rows[0] || null;
}

async function listSeoVideos(limit = 50, offset = 0) {
  await init();
  const result = await pool.query(`SELECT p.video_id AS "videoId", p.source, p.context, p.package, p.status, p.attempts,
    p.error, p.applied, p.auto_result AS "autoResult", p.playlist_result AS "playlistResult",
    p.generated_at AS "generatedAt", p.updated_at AS "updatedAt",
    a.analysis, a.model AS "analysisModel", a.analyzed_at AS "analyzedAt",
    (SELECT jsonb_agg(jsonb_build_object(
        'periodStart', snapshot.period_start,
        'periodEnd', snapshot.period_end,
        'clicks', snapshot.clicks,
        'impressions', snapshot.impressions,
        'ctr', snapshot.ctr,
        'averagePosition', snapshot.average_position,
        'importedAt', snapshot.imported_at
      ) ORDER BY snapshot.period_end DESC, snapshot.period_start DESC)
      FROM (
        SELECT period_start, period_end, clicks, impressions, ctr, average_position, imported_at
        FROM amaana_google_search_snapshots
        WHERE video_id = p.video_id
        ORDER BY period_end DESC, period_start DESC
        LIMIT 2
      ) snapshot) AS "googleSearchSnapshots",
    (SELECT jsonb_agg(jsonb_build_object(
        'periodStart', snapshot.period_start,
        'periodEnd', snapshot.period_end,
        'googleSearchReferralViews', snapshot.google_referral_views,
        'googleSearchReferralComplete', snapshot.google_referral_complete,
        'googleSearchDetailRows', snapshot.google_detail_rows,
        'youtubeSearchViews', snapshot.youtube_search_views,
        'importedAt', snapshot.imported_at
      ) ORDER BY snapshot.period_end DESC, snapshot.period_start DESC)
      FROM (
        SELECT period_start, period_end, google_referral_views, google_referral_complete,
          google_detail_rows, youtube_search_views, imported_at
        FROM amaana_youtube_search_snapshots
        WHERE video_id = p.video_id
        ORDER BY period_end DESC, period_start DESC
        LIMIT 2
      ) snapshot) AS "youtubeSearchSnapshots"
    FROM amaana_seo_packages p LEFT JOIN amaana_video_analysis a ON a.video_id = p.video_id
    ORDER BY CASE WHEN p.source->>'privacyStatus' = 'public' THEN 0 ELSE 1 END,
      CASE WHEN p.source->>'privacyStatus' = 'public'
        AND p.source->>'viewCount' ~ '^[0-9]+$' THEN 0 ELSE 1 END,
      CASE WHEN p.source->>'privacyStatus' = 'public'
        AND p.source->>'viewCount' ~ '^[0-9]+$'
        THEN (p.source->>'viewCount')::numeric END ASC NULLS LAST,
      CASE WHEN p.source->>'privacyStatus' = 'public' THEN p.source->>'publishedAt' END ASC NULLS LAST,
      CASE WHEN p.source->>'privacyStatus' IS DISTINCT FROM 'public'
        THEN p.source->>'publishedAt' END DESC NULLS LAST,
      p.created_at DESC
    LIMIT $1 OFFSET $2`, [Math.min(100, Math.max(1, limit)), Math.max(0, offset)]);
  return result.rows;
}

async function countPublicSeoVideos(channelId) {
  await init();
  const safeChannelId = String(channelId || '').trim();
  const result = safeChannelId
    ? await pool.query(
      "SELECT COUNT(*)::integer AS count FROM amaana_seo_packages " +
      "WHERE source->>'privacyStatus' = 'public' AND source->>'channelId' = $1", [safeChannelId])
    : await pool.query(
      "SELECT COUNT(*)::integer AS count FROM amaana_seo_packages " +
      "WHERE source->>'privacyStatus' = 'public'");
  return result.rows[0]?.count || 0;
}

async function listPublicSeoMetadata(channelId, limit = 5000) {
  await init();
  const safeChannelId = String(channelId || '').trim();
  if (!safeChannelId) throw new Error('A YouTube channel ID is required for duplicate metadata checks');
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(5000, limit)) : 5000;
  const result = await pool.query('SELECT video_id AS "videoId", source->>\'title\' AS title, ' +
    'source->>\'description\' AS description FROM amaana_seo_packages ' +
    'WHERE source->>\'privacyStatus\' = \'public\' AND source->>\'channelId\' = $1 ' +
    'ORDER BY updated_at DESC, video_id ASC LIMIT $2', [safeChannelId, safeLimit]);
  return result.rows;
}

async function listYoutubeSearchCandidates(limit = 20, offset = 0) {
  await init();
  const safeLimit = Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 20));
  const safeOffset = Math.max(0, Number.isSafeInteger(offset) ? offset : 0);
  const result = await pool.query(
    "SELECT video_id FROM amaana_seo_packages " +
    "WHERE source->>'privacyStatus' = 'public' " +
    "ORDER BY CASE WHEN source->>'viewCount' ~ '^[0-9]+$' THEN 0 ELSE 1 END, " +
    "CASE WHEN source->>'viewCount' ~ '^[0-9]+$' " +
    "THEN (source->>'viewCount')::numeric END ASC NULLS LAST, " +
    "CASE WHEN source->>'publishedAt' IS NOT NULL THEN source->>'publishedAt' END ASC NULLS LAST, " +
    "video_id ASC LIMIT $1 OFFSET $2", [safeLimit, safeOffset]);
  return result.rows.map((row) => ({ videoId: row.video_id }));
}

async function saveYoutubeSearchSnapshots(snapshots) {
  await init();
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 100) {
    throw new Error('Save between 1 and 100 YouTube Analytics video snapshots');
  }
  for (const snapshot of snapshots) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(snapshot.videoId || '')) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.startDate || '')) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.endDate || '')) ||
        snapshot.startDate > snapshot.endDate ||
        snapshot.googleSearchReferralViews !== null &&
          (!Number.isSafeInteger(snapshot.googleSearchReferralViews) || snapshot.googleSearchReferralViews < 0) ||
        typeof snapshot.googleSearchReferralComplete !== 'boolean' ||
        !Number.isSafeInteger(snapshot.googleSearchDetailRows) || snapshot.googleSearchDetailRows < 0 ||
          snapshot.googleSearchDetailRows > 25 ||
        !Number.isSafeInteger(snapshot.youtubeSearchViews) || snapshot.youtubeSearchViews < 0) {
      throw new Error('YouTube Analytics snapshot contains invalid video metrics');
    }
  }
  const result = await pool.query(
    "INSERT INTO amaana_youtube_search_snapshots " +
    "(video_id, period_start, period_end, google_referral_views, google_referral_complete, " +
    "google_detail_rows, youtube_search_views, imported_at) " +
    "SELECT input.video_id, input.period_start, input.period_end, input.google_referral_views, " +
    "input.google_referral_complete, input.google_detail_rows, input.youtube_search_views, NOW() " +
    "FROM jsonb_to_recordset($1::jsonb) AS input(" +
    "video_id TEXT, period_start DATE, period_end DATE, google_referral_views BIGINT, " +
    "google_referral_complete BOOLEAN, google_detail_rows INTEGER, youtube_search_views BIGINT) " +
    "JOIN amaana_seo_packages p ON p.video_id = input.video_id " +
    "WHERE p.source->>'privacyStatus' = 'public' " +
    "ON CONFLICT (video_id, period_start, period_end) DO UPDATE SET " +
    "google_referral_views = EXCLUDED.google_referral_views, " +
    "google_referral_complete = EXCLUDED.google_referral_complete, " +
    "google_detail_rows = EXCLUDED.google_detail_rows, " +
    "youtube_search_views = EXCLUDED.youtube_search_views, imported_at = NOW() " +
    "RETURNING video_id",
    [JSON.stringify(snapshots.map((snapshot) => ({
      video_id: snapshot.videoId,
      period_start: snapshot.startDate,
      period_end: snapshot.endDate,
      google_referral_views: snapshot.googleSearchReferralViews,
      google_referral_complete: snapshot.googleSearchReferralComplete,
      google_detail_rows: snapshot.googleSearchDetailRows,
      youtube_search_views: snapshot.youtubeSearchViews
    })))]);
  return { savedCount: result.rowCount, skippedCount: snapshots.length - result.rowCount };
}

async function saveGoogleSearchSnapshots(snapshots, periodStart, periodEnd) {
  await init();
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 2000) {
    throw new Error('Import between 1 and 2,000 Google Search Console video rows');
  }
  for (const snapshot of snapshots) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(snapshot.videoId || '')) ||
        !Number.isSafeInteger(snapshot.clicks) || snapshot.clicks < 0 ||
        !Number.isSafeInteger(snapshot.impressions) || snapshot.impressions < 0 ||
        snapshot.averagePosition !== null &&
          (!Number.isFinite(snapshot.averagePosition) || snapshot.averagePosition < 0)) {
      throw new Error('Google Search Console snapshot contains invalid video metrics');
    }
  }

  const result = await pool.query(`INSERT INTO amaana_google_search_snapshots
      (video_id, period_start, period_end, clicks, impressions, ctr, average_position, imported_at)
    SELECT input.video_id, $2::date, $3::date, input.clicks, input.impressions,
      CASE WHEN input.impressions > 0
        THEN input.clicks::numeric / input.impressions::numeric ELSE 0 END,
      input.average_position, NOW()
    FROM jsonb_to_recordset($1::jsonb) AS input(
      video_id TEXT, clicks BIGINT, impressions BIGINT, average_position NUMERIC
    )
    JOIN amaana_seo_packages p ON p.video_id = input.video_id
    WHERE p.source->>'privacyStatus' = 'public'
    ON CONFLICT (video_id, period_start, period_end) DO UPDATE SET
      clicks = EXCLUDED.clicks,
      impressions = EXCLUDED.impressions,
      ctr = EXCLUDED.ctr,
      average_position = EXCLUDED.average_position,
      imported_at = NOW()
    RETURNING video_id AS "videoId", period_start AS "periodStart", period_end AS "periodEnd",
      clicks, impressions, ctr, average_position AS "averagePosition", imported_at AS "importedAt"`,
  [JSON.stringify(snapshots.map((snapshot) => ({
    video_id: snapshot.videoId, clicks: snapshot.clicks, impressions: snapshot.impressions,
    average_position: snapshot.averagePosition
  }))), periodStart, periodEnd]);
  return { savedCount: result.rowCount, skippedCount: snapshots.length - result.rowCount };
}

async function listSeoChannelCandidates(limit = 100) {
  await init();
  const result = await pool.query(`SELECT p.video_id AS "videoId", p.source, p.context, p.package,
    a.analysis FROM amaana_seo_packages p
    LEFT JOIN amaana_video_analysis a ON a.video_id = p.video_id
    WHERE p.source->>'privacyStatus' = 'public' AND p.package IS NOT NULL
    ORDER BY p.generated_at DESC NULLS LAST LIMIT $1`, [Math.min(100, Math.max(1, limit))]);
  return result.rows;
}

async function listSeoNeedsPlaylist(limit = 20, privacyGroup = 'all') {
  await init();
  const requestedLimit = Number(limit);
  const safeLimit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
  const privacyStatuses = privacyGroup === 'public' ? ['public']
    : privacyGroup === 'nonpublic' ? ['private', 'unlisted']
      : privacyGroup === 'all' ? ['public', 'private', 'unlisted'] : null;
  if (!privacyStatuses) throw new Error('Invalid playlist privacy queue');
  const result = await pool.query(`SELECT video_id AS "videoId", source, context, package
    FROM amaana_seo_packages
    WHERE source->>'privacyStatus' = ANY($2::text[])
      AND (playlist_result IS NULL OR
        (playlist_result->>'state' = 'retry' AND
         (playlist_result->>'at')::timestamptz < NOW() - INTERVAL '1 hour'))
    ORDER BY (source->>'publishedAt') ASC NULLS LAST, created_at ASC
    LIMIT $1`, [safeLimit, privacyStatuses]);
  return result.rows;
}

async function markSeoPlaylistResult(videoId, result) {
  await init();
  await pool.query(`UPDATE amaana_seo_packages SET playlist_result = $2::jsonb, updated_at = NOW()
    WHERE video_id = $1`, [videoId, JSON.stringify(result)]);
}

async function resetSeoPlaylistResults() {
  await init();
  const result = await pool.query(`UPDATE amaana_seo_packages
    SET playlist_result = NULL, updated_at = NOW()
    WHERE source->>'privacyStatus' IN ('public', 'private', 'unlisted')
      AND playlist_result->>'state' IN ('no_match', 'ambiguous')`);
  return result.rowCount;
}

async function requeueSeoPlaylistResults(videoIds = []) {
  await init();
  if (!Array.isArray(videoIds)) throw new Error('Video IDs must be an array');
  const ids = [...new Set(videoIds.filter((videoId) => /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))))];
  if (ids.length > 5000) throw new Error('Playlist coverage repair is limited to 5,000 videos per request');
  if (!ids.length) return 0;
  const result = await pool.query(`UPDATE amaana_seo_packages
    SET playlist_result = NULL, updated_at = NOW()
    WHERE video_id = ANY($1::text[])
      AND source->>'privacyStatus' IN ('public', 'private', 'unlisted')
      AND playlist_result->>'state' IN ('added', 'already_added', 'fallback_added', 'fallback_already_added')`, [ids]);
  return result.rowCount;
}

async function requeueSeoPlaylistAuthorizationFailures() {
  await init();
  const result = await pool.query(`UPDATE amaana_seo_packages
    SET playlist_result = NULL, updated_at = NOW()
    WHERE playlist_result->>'state' = 'authorization_required'
      AND source->>'privacyStatus' IN ('public', 'private', 'unlisted')`);
  return result.rowCount;
}

async function getVideoAnalysis(videoId) {
  await init();
  const result = await pool.query(`SELECT analysis, model, analyzed_at AS "analyzedAt"
    FROM amaana_video_analysis WHERE video_id = $1`, [videoId]);
  return result.rows[0] || null;
}

async function saveVideoAnalysis(videoId, analysis, model) {
  await init();
  await pool.query(`INSERT INTO amaana_video_analysis (video_id, analysis, model)
    VALUES ($1, $2::jsonb, $3) ON CONFLICT (video_id) DO NOTHING`,
  [videoId, JSON.stringify(analysis), model]);
}

async function seoCounts() {
  await init();
  const results = await Promise.all([
    pool.query('SELECT status, COUNT(*)::integer AS count FROM amaana_seo_packages GROUP BY status'),
    pool.query("SELECT COUNT(*)::integer AS count FROM amaana_seo_packages WHERE last_attempt_at >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')"),
    pool.query('SELECT COUNT(*)::integer AS count FROM amaana_seo_packages WHERE applied IS NOT NULL')
  ]);
  return {
    statuses: Object.fromEntries(results[0].rows.map(({ status, count }) => [status, count])),
    attemptedToday: results[1].rows[0].count,
    appliedTotal: results[2].rows[0].count
  };
}

async function requeueLegacySeoTagFailures() {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(`INSERT INTO amaana_state (key, value, updated_at)
      VALUES ('seo_tag_recovery_focused_v1', '{"done":true}'::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING RETURNING key`);
    if (!claimed.rowCount) {
      await client.query('COMMIT');
      return 0;
    }
    const result = await client.query(`UPDATE amaana_seo_packages
      SET status = 'queued', package = NULL, attempts = 0, error = NULL,
        next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL,
        generated_at = NULL, auto_result = NULL, updated_at = NOW()
      WHERE status = 'failed'
        AND source->>'privacyStatus' = 'public' AND (
        error ILIKE 'Expected 10%15%tag%'
        OR error ILIKE 'Tags exceed the recommended combined length%'
        OR error ILIKE 'Tags must include the exact primary keyword%'
      )
      RETURNING video_id`);
    await client.query('COMMIT');
    return result.rowCount;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function updateSeoContext(videoId, context) {
  await init();
  const result = await pool.query(`UPDATE amaana_seo_packages
    SET context = $2::jsonb, status = 'queued', package = NULL, attempts = 0,
      error = NULL, next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL, updated_at = NOW()
    WHERE video_id = $1 RETURNING video_id`, [videoId, JSON.stringify(context)]);
  return Boolean(result.rowCount);
}

async function claimSeoVideo() {
  await init();
  const token = crypto.randomUUID();
  const result = await pool.query(`WITH candidate AS (
      SELECT video_id FROM amaana_seo_packages
      WHERE source->>'privacyStatus' = 'public'
        AND ((status IN ('queued', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
        OR (status = 'generating' AND claimed_at < NOW() - INTERVAL '20 minutes'))
      ORDER BY CASE WHEN source->>'viewCount' ~ '^[0-9]+$' THEN 0 ELSE 1 END,
        CASE WHEN source->>'viewCount' ~ '^[0-9]+$'
          THEN (source->>'viewCount')::numeric END ASC NULLS LAST,
        source->>'publishedAt' ASC NULLS LAST, created_at ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE amaana_seo_packages p SET status = 'generating', claim_token = $1,
      claimed_at = NOW(), last_attempt_at = NOW(), attempts = attempts + 1, updated_at = NOW()
    FROM candidate WHERE p.video_id = candidate.video_id
    RETURNING p.video_id AS "videoId", p.source, p.context, p.attempts`, [token]);
  return result.rows[0] ? { ...result.rows[0], claimToken: token } : null;
}

async function finishSeoVideo(videoId, claimToken, generated, error) {
  await init();
  const status = generated ? (generated.missingEvidence.length ? 'needs_review' : 'ready') :
    (error.retry ? 'retry' : 'failed');
  const next = error?.retry ? new Date(Date.now() + Math.min(24, 2 ** error.attempts) * 60 * 60 * 1000) : null;
  await pool.query(`UPDATE amaana_seo_packages SET package = $3::jsonb, status = $4,
    generated_at = CASE WHEN $3::jsonb IS NOT NULL THEN NOW() ELSE generated_at END,
    next_attempt_at = $5, error = $6, claim_token = NULL, claimed_at = NULL, updated_at = NOW()
    WHERE video_id = $1 AND claim_token = $2`,
  [videoId, claimToken, generated ? JSON.stringify(generated) : null, status, next, error?.message || null]);
}

async function markSeoApplied(videoId, applied) {
  await init();
  await pool.query(`UPDATE amaana_seo_packages SET applied = $2::jsonb, updated_at = NOW()
    WHERE video_id = $1`, [videoId, JSON.stringify(applied)]);
}

async function markSeoAutoResult(videoId, result) {
  await init();
  await pool.query(`UPDATE amaana_seo_packages SET auto_result = $2::jsonb, updated_at = NOW()
    WHERE video_id = $1`, [videoId, JSON.stringify(result)]);
}

async function listSeoAutoCandidates(limit = 20, autopilotVersion = SEO_AUTOPILOT_VERSION) {
  await init();
  const result = await pool.query(`SELECT video_id AS "videoId", status,
      CASE WHEN status = 'ready' THEN 0
        WHEN jsonb_typeof(package->'missingEvidence') = 'array'
          THEN jsonb_array_length(package->'missingEvidence')
        ELSE 2147483647 END AS "missingEvidenceCount",
      generated_at AS "generatedAt",
      CASE WHEN source->>'viewCount' ~ '^[0-9]+$'
        THEN source->>'viewCount' ELSE NULL END AS "viewCount"
    FROM amaana_seo_packages
    WHERE status IN ('ready', 'needs_review')
      AND source->>'privacyStatus' = 'public'
      AND generated_at IS NOT NULL
      AND (auto_result IS NULL
        OR auto_result->>'autopilotVersion' IS DISTINCT FROM $1
        OR (auto_result->>'packageGeneratedAt')::timestamptz IS DISTINCT FROM generated_at
        OR (auto_result->>'state' = 'retry' AND (auto_result->>'at')::timestamptz < NOW() - INTERVAL '1 hour')
        OR auto_result->>'reason' = 'Video analysis or owner supplied video context is required for automatic publishing'
        OR ((auto_result->>'packageGeneratedAt')::timestamptz = generated_at
          AND auto_result->>'thumbnailState' IS NULL)
        OR (auto_result->>'thumbnailState' = 'retry' AND (auto_result->>'at')::timestamptz < NOW() - INTERVAL '1 hour'))
    ORDER BY generated_at ASC NULLS LAST, video_id ASC`, [autopilotVersion]);
  return prioritizeSeoAutoCandidates(result.rows, limit);
}

async function seoUpdatesToday() {
  await init();
  const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM amaana_seo_packages
    WHERE (applied->>'at')::timestamptz >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      OR (auto_result->>'thumbnailAt')::timestamptz >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  return result.rows[0].count;
}

async function listSeoNeedsAnalysis(limit = 20) {
  await init();
  const requestedLimit = Number(limit);
  const safeLimit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(50, requestedLimit)) : 20;
  const result = await pool.query(`SELECT p.video_id AS "videoId", p.context
    FROM amaana_seo_packages p
    LEFT JOIN amaana_video_analysis a ON a.video_id = p.video_id
    WHERE p.status IN ('ready', 'needs_review')
      AND p.source->>'privacyStatus' = 'public'
      AND a.video_id IS NULL
      AND COALESCE(p.context->>'takeaways', '') = ''
      AND p.generated_at < NOW() - INTERVAL '6 hours'
    ORDER BY CASE WHEN p.source->>'viewCount' ~ '^[0-9]+$' THEN 0 ELSE 1 END,
      CASE WHEN p.source->>'viewCount' ~ '^[0-9]+$'
        THEN (p.source->>'viewCount')::numeric END ASC NULLS LAST,
      p.generated_at ASC LIMIT $1`, [safeLimit]);
  return result.rows;
}

async function nextSeoNeedsAnalysis() {
  const candidates = await listSeoNeedsAnalysis(1);
  return candidates[0] || null;
}

module.exports = {
  pool,
  databaseConnectionString,
  init,
  ping,
  saveTokens,
  getTokens,
  saveTwitchTokens,
  getTwitchTokens,
  saveTikTokTokens,
  getTikTokTokens,
  listDrafts,
  getDraft,
  addDraft,
  updateDraft,
  claimTikTokDelivery,
  saveSeoSyncState,
  getSeoSyncState,
  getSeoMarketSnapshot,
  saveSeoMarketSnapshot,
  getSeoMarketBudget,
  saveSeoMarketBudget,
  reservePlaylistAutoSlot,
  upsertSeoVideo,
  getSeoVideo,
  listSeoVideos,
  countPublicSeoVideos,
  listPublicSeoMetadata,
  listYoutubeSearchCandidates,
  saveYoutubeSearchSnapshots,
  saveGoogleSearchSnapshots,
  listSeoChannelCandidates,
  listSeoNeedsPlaylist,
  markSeoPlaylistResult,
  resetSeoPlaylistResults,
  requeueSeoPlaylistResults,
  requeueSeoPlaylistAuthorizationFailures,
  getVideoAnalysis,
  saveVideoAnalysis,
  seoCounts,
  requeueLegacySeoTagFailures,
  updateSeoContext,
  claimSeoVideo,
  finishSeoVideo,
  markSeoApplied,
  markSeoAutoResult,
  listSeoAutoCandidates,
  seoUpdatesToday,
  listSeoNeedsAnalysis,
  nextSeoNeedsAnalysis
};
