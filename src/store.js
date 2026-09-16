const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const storeFile = path.join(dataDir, 'store.json');

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(storeFile)) {
    fs.writeFileSync(storeFile, JSON.stringify({ encryptedTokens: null, drafts: [] }, null, 2), { mode: 0o600 });
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
}

function writeStore(data) {
  ensureStore();
  const temp = storeFile + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, storeFile);
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

function saveTokens(tokens) {
  const data = readStore();
  data.encryptedTokens = encrypt(tokens);
  writeStore(data);
}

function getTokens() {
  return decrypt(readStore().encryptedTokens);
}

function listDrafts() {
  return readStore().drafts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function addDraft(draft) {
  const data = readStore();
  data.drafts.push(draft);
  writeStore(data);
  return draft;
}

function updateDraft(id, patch) {
  const data = readStore();
  const index = data.drafts.findIndex((draft) => draft.id === id);
  if (index < 0) return null;
  data.drafts[index] = { ...data.drafts[index], ...patch, updatedAt: new Date().toISOString() };
  writeStore(data);
  return data.drafts[index];
}

module.exports = { saveTokens, getTokens, listDrafts, addDraft, updateDraft };
