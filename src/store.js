const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
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

module.exports = {
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
  claimTikTokDelivery
};
