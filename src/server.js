require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const store = require('./store');
const youtube = require('./youtube');
const twitch = require('./twitch');
const video = require('./video');
const tiktok = require('./tiktok');

for (const name of ['BASE_URL', 'DATABASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'AGENT_KEY', 'ADMIN_KEY']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const app = express();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
const publicDir = path.resolve(__dirname, '../public');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('video/'))
});

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 60 * 1000 }
}));
app.use(express.static(publicDir, { index: false, maxAge: '1h' }));

function keysMatch(supplied, expected) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function keyGuard(environmentName, message) {
  return (req, res, next) => {
    const supplied = req.get(environmentName === 'ADMIN_KEY' ? 'x-admin-key' : 'x-agent-key');
    if (!keysMatch(supplied, process.env[environmentName])) return res.status(401).json({ error: message });
    next();
  };
}

const agentKey = keyGuard('AGENT_KEY', 'Agent key required');
const clipQueue = [];
const queuedClipIds = new Set();
let clipWorkerRunning = false;
const tiktokJobs = new Set();

function tiktokMediaPath(id) {
  return path.join(uploadDir, `tiktok-${id}.mp4`);
}

function tiktokMediaSignature(id, expires) {
  return crypto.createHmac('sha256', process.env.TOKEN_ENCRYPTION_KEY)
    .update(`${id}:${expires}`).digest('hex');
}

async function generateTikTokShort(draft) {
  const parent = await store.getDraft(draft.parentId);
  const clip = parent?.twitchClips?.[draft.highlightIndex];
  if (parent?.sourceType !== 'twitch_highlight_batch' || !clip?.id) {
    throw new Error('Source Twitch clip is unavailable for this Short');
  }
  const directory = path.join(uploadDir, `tiktok-work-${draft.id}`);
  const output = tiktokMediaPath(draft.id);
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    const download = await twitch.waitForClipDownload({
      clipId: clip.id, broadcasterId: clip.broadcasterId, editorId: clip.editorId
    });
    const url = download.landscape_download_url || download.portrait_download_url;
    if (!url) throw new Error('Twitch clip media is no longer available');
    const source = path.join(directory, 'source.mp4');
    const highlight = path.join(directory, 'highlight.mp4');
    const short = path.join(directory, 'short.mp4');
    await twitch.downloadClip(url, source);
    const durations = await video.assembleHighlights([source], highlight, directory);
    await video.shortFromHighlight(highlight, 0, Math.min(60, durations[0]), short);
    await fs.promises.rename(short, output);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return output;
}

async function sendTikTokShort(id) {
  let initiatedPublishId;
  try {
    const draft = await store.getDraft(id);
    if (!draft || draft.sourceType !== 'twitch_highlight_short') return;
    await generateTikTokShort(draft);
    const expires = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    const signature = tiktokMediaSignature(id, expires);
    const url = new URL(`/tiktok-media/${id}/${expires}/${signature}.mp4`, process.env.BASE_URL);
    if (url.protocol !== 'https:') throw new Error('TikTok requires an HTTPS media URL');
    initiatedPublishId = await tiktok.uploadToInbox(url.toString());
    await store.updateDraft(id, { tiktokStatus: 'processing_download', tiktokPublishId: initiatedPublishId,
      tiktokError: null, tiktokSentAt: new Date().toISOString() });
  } catch (error) {
    console.error(`TikTok inbox job ${id} failed:`, error.message);
    if (initiatedPublishId) {
      // TikTok may already be downloading. Keep the file available if database persistence fails.
      await store.updateDraft(id, { tiktokStatus: 'processing_download', tiktokPublishId: initiatedPublishId,
        tiktokError: cleanText(error.message, 300) }).catch(() => {});
    } else {
      unlinkQuietly(tiktokMediaPath(id));
      await store.updateDraft(id, { tiktokStatus: 'failed', tiktokError: cleanText(error.message, 300) }).catch(() => {});
    }
  } finally {
    if (initiatedPublishId) {
      const timer = setTimeout(() => unlinkQuietly(tiktokMediaPath(id)), 2 * 60 * 60 * 1000);
      timer.unref();
    }
    tiktokJobs.delete(id);
  }
}

function admin(req, res, next) {
  if (req.session?.adminAuthenticated || keysMatch(req.get('x-admin-key'), process.env.ADMIN_KEY)) return next();
  return res.status(401).json({ error: 'Owner approval required' });
}

function agentOrAdmin(req, res, next) {
  if (req.session?.adminAuthenticated || keysMatch(req.get('x-admin-key'), process.env.ADMIN_KEY)) return next();
  return agentKey(req, res, next);
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function formatOffset(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

function normalizeHighlights(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('timestamps must contain at least one AI highlight');
  const normalized = items.slice(0, 10).map((item, index) => {
    let start = Number(item?.startSeconds);
    let end = Number(item?.endSeconds ?? item?.vodOffset);
    if (!Number.isFinite(end) && Number.isFinite(start)) end = start + Number(item?.duration || 30);
    if (!Number.isFinite(start) && Number.isFinite(end)) start = end - Number(item?.duration || 30);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= 0) {
      throw new Error(`Highlight ${index + 1} has invalid startSeconds/endSeconds`);
    }
    let duration = Math.min(60, Math.max(5, end - start));
    end = Math.max(duration, Math.round(end));
    start = Math.max(0, end - duration);
    duration = end - start;
    const fallbackTitle = `Saevond highlight at ${formatOffset(end)}`;
    return {
      startSeconds: Number(start.toFixed(1)),
      endSeconds: Number(end.toFixed(1)),
      duration: Number(duration.toFixed(1)),
      title: cleanText(item?.title || fallbackTitle, 100),
      reason: cleanText(item?.reason, 500),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null
    };
  });
  const deduplicated = [];
  for (const item of normalized.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (!deduplicated.some((existing) => Math.abs(existing.endSeconds - item.endSeconds) < 12)) deduplicated.push(item);
  }
  return deduplicated.slice(0, 8).sort((a, b) => a.startSeconds - b.startSeconds);
}

function unlinkQuietly(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

async function processTwitchClipDraft(id) {
  let sourcePath;
  let shortPath;
  try {
    let draft = await store.getDraft(id);
    if (!draft || draft.sourceType !== 'twitch_vod' || draft.status === 'awaiting_owner_approval') return;
    if (!await twitch.isConnected()) throw new Error('Connect Twitch in Amaana before processing VOD highlights');

    if (!draft.twitchClipId) {
      draft = await store.updateDraft(id, { status: 'creating_twitch_clip', error: null });
      const clip = await twitch.createClipFromVod({
        vodId: draft.vodId,
        vodOffset: draft.endSeconds,
        duration: draft.duration,
        title: draft.title
      });
      draft = await store.updateDraft(id, {
        status: 'waiting_for_clip_media',
        twitchClipId: clip.id,
        twitchEditUrl: clip.edit_url,
        twitchUrl: `https://clips.twitch.tv/${clip.id}`,
        twitchBroadcasterId: clip.broadcasterId,
        twitchEditorId: clip.editorId
      });
    }

    const download = await twitch.waitForClipDownload({
      clipId: draft.twitchClipId,
      broadcasterId: draft.twitchBroadcasterId,
      editorId: draft.twitchEditorId
    });
    const portraitUrl = download.portrait_download_url;
    const landscapeUrl = download.landscape_download_url;
    if (!portraitUrl && !landscapeUrl) throw new Error('Twitch did not provide downloadable clip media');

    sourcePath = path.join(uploadDir, `${id}-source.mp4`);
    shortPath = path.join(uploadDir, `${id}-short.mp4`);
    await Promise.all([
      fs.promises.rm(sourcePath, { force: true }),
      fs.promises.rm(shortPath, { force: true })
    ]);
    await store.updateDraft(id, { status: 'downloading_twitch_clip' });
    if (portraitUrl) {
      await twitch.downloadClip(portraitUrl, shortPath);
    } else {
      await twitch.downloadClip(landscapeUrl, sourcePath);
      await store.updateDraft(id, { status: 'formatting_vertical_short' });
      await video.convertLandscapeToShort(sourcePath, shortPath);
    }

    await store.updateDraft(id, { status: 'uploading_private_to_youtube' });
    const sourceUrl = `https://www.twitch.tv/videos/${draft.vodId}?t=${Math.floor(draft.startSeconds)}s`;
    const description = [
      draft.reason || 'AI-detected highlight from a Saevond livestream.',
      '',
      `Full Twitch VOD: ${sourceUrl}`,
      '',
      '#Saevond #Gaming #Shorts'
    ].join('\n');
    const uploaded = await youtube.uploadPrivate({
      filePath: shortPath,
      title: draft.title,
      description,
      tags: ['Saevond', 'gaming', 'livestream highlights', 'Shorts'],
      madeForKids: false
    });
    await store.updateDraft(id, {
      youtubeVideoId: uploaded.id,
      status: 'awaiting_owner_approval',
      error: null,
      processedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(`Twitch clip job ${id} failed:`, error.message);
    await store.updateDraft(id, { status: 'clip_failed', error: cleanText(error.message, 500) }).catch(() => {});
  } finally {
    unlinkQuietly(sourcePath);
    unlinkQuietly(shortPath);
  }
}

async function runClipQueue() {
  if (clipWorkerRunning) return;
  clipWorkerRunning = true;
  try {
    while (clipQueue.length) {
      const id = clipQueue.shift();
      try { await processTwitchClipDraft(id); } finally { queuedClipIds.delete(id); }
    }
  } finally {
    clipWorkerRunning = false;
  }
}

function enqueueClipProcessing(id) {
  if (queuedClipIds.has(id)) return;
  queuedClipIds.add(id);
  clipQueue.push(id);
  setImmediate(() => runClipQueue().catch((error) => console.error('Clip queue failed:', error.message)));
}

async function processHighlightBatch(id) {
  const directory = path.join(uploadDir, `highlights-${id}`);
  try {
    const batch = await store.getDraft(id);
    if (!batch || batch.sourceType !== 'twitch_highlight_batch' || batch.status === 'completed') return;
    await fs.promises.mkdir(directory, { recursive: true });
    await store.updateDraft(id, { status: 'creating_twitch_clips', error: null });
    const sources = [];
    const twitchClips = [...(batch.twitchClips || [])];
    for (let index = 0; index < batch.highlights.length; index += 1) {
      const moment = batch.highlights[index];
      const clip = twitchClips[index] || await twitch.createClipFromVod({ vodId: batch.vodId, vodOffset: moment.endSeconds, duration: moment.duration, title: moment.title });
      if (!twitchClips[index]) {
        twitchClips[index] = clip;
        await store.updateDraft(id, { twitchClips });
      }
      const download = await twitch.waitForClipDownload({ clipId: clip.id, broadcasterId: clip.broadcasterId, editorId: clip.editorId });
      const url = download.landscape_download_url || download.portrait_download_url;
      if (!url) throw new Error('Twitch clip media was unavailable');
      const source = path.join(directory, `source-${index}.mp4`);
      await twitch.downloadClip(url, source);
      sources.push(source);
    }
    const montage = path.join(directory, 'highlight.mp4');
    await store.updateDraft(id, { status: 'assembling_highlight_video' });
    const durations = await video.assembleHighlights(sources, montage, directory);
    const highlight = batch.youtubeVideoId ? { id: batch.youtubeVideoId } : await youtube.uploadPrivate({
      filePath: montage,
      title: cleanText(`${batch.streamTitle || 'Saevond livestream'} | Best moments`, 100),
      description: `Highlights from https://www.twitch.tv/videos/${batch.vodId}\n#Saevond #Gaming`,
      tags: ['Saevond', 'gaming', 'livestream highlights']
    });
    await store.updateDraft(id, { status: 'creating_shorts', youtubeVideoId: highlight.id, duration: durations.reduce((a, b) => a + b, 0) });
    const existingShorts = (await store.listDrafts()).filter((draft) => draft.parentId === id);
    let offset = 0;
    const failures = [];
    for (let index = 0; index < batch.highlights.length; index += 1) {
      const moment = batch.highlights[index];
      const length = Math.min(60, durations[index]);
      const shortPath = path.join(directory, `short-${index}.mp4`);
      try {
        if (existingShorts.some((draft) => draft.highlightIndex === index)) { offset += durations[index]; continue; }
        await video.shortFromHighlight(montage, offset, length, shortPath);
        const uploaded = await youtube.uploadPrivate({ filePath: shortPath, title: moment.title,
          description: `${moment.reason || 'Livestream highlight'}\n\nHighlight video: https://youtu.be/${highlight.id}\n#Saevond #Shorts`,
          tags: ['Saevond', 'gaming', 'Shorts'] });
        await store.addDraft({ id: crypto.randomUUID(), sourceType: 'twitch_highlight_short', parentId: id, highlightIndex: index,
          vodId: batch.vodId, title: moment.title, youtubeVideoId: uploaded.id,
          status: 'awaiting_owner_approval', createdAt: new Date().toISOString() });
      } catch (error) {
        failures.push(`${index + 1}: ${cleanText(error.message, 150)}`);
      }
      offset += durations[index];
    }
    await store.updateDraft(id, { status: 'awaiting_owner_approval',
      error: failures.length ? failures.join('; ') : null, processedAt: new Date().toISOString() });
  } catch (error) {
    console.error(`Highlight batch ${id} failed:`, error.message);
    await store.updateDraft(id, { status: 'clip_failed', error: cleanText(error.message, 500) }).catch(() => {});
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const batchQueue = [];
const queuedBatchIds = new Set();
let batchWorkerRunning = false;
function enqueueHighlightBatch(id) {
  if (queuedBatchIds.has(id)) return;
  queuedBatchIds.add(id);
  batchQueue.push(id);
  setImmediate(async () => {
    if (batchWorkerRunning) return;
    batchWorkerRunning = true;
    try {
      while (batchQueue.length) {
        const next = batchQueue.shift();
        try { await processHighlightBatch(next); } finally { queuedBatchIds.delete(next); }
      }
    } finally { batchWorkerRunning = false; }
  });
}

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/healthz', async (_req, res) => {
  try {
    await store.ping();
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

// TikTok pulls this temporary file after an owner explicitly sends a Short.
// The URL is signed, expires, and contains no account credentials.
app.get('/tiktok-media/:filename', (req, res, next) => {
  if (!process.env.TIKTOK_VERIFICATION_FILENAME || !process.env.TIKTOK_VERIFICATION_CONTENT ||
      req.params.filename !== process.env.TIKTOK_VERIFICATION_FILENAME) return next();
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').end(process.env.TIKTOK_VERIFICATION_CONTENT);
});

app.get('/tiktok-media/:id/:expires/:signature.mp4', (req, res) => {
  const { id, expires, signature } = req.params;
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^\d{10}$/.test(expires) ||
      Number(expires) < Date.now() / 1000 || Number(expires) > Date.now() / 1000 + 2 * 60 * 60 ||
      !keysMatch(signature, tiktokMediaSignature(id, expires))) {
    return res.status(404).end();
  }
  res.set('Cache-Control', 'no-store');
  res.type('mp4');
  res.sendFile(tiktokMediaPath(id), (error) => {
    if (error && !res.headersSent) res.status(error.status || 404).end();
  });
});

app.get('/api/admin/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: Boolean(req.session?.adminAuthenticated) });
});

app.post('/api/admin/login', (req, res, next) => {
  if (!keysMatch(req.body?.key, process.env.ADMIN_KEY)) {
    return res.status(401).json({ error: 'Incorrect admin key' });
  }
  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.adminAuthenticated = true;
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.json({ ok: true });
    });
  });
});

app.post('/api/admin/logout', admin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/youtube/status', admin, async (_req, res, next) => {
  try {
    res.json({ connected: await youtube.isConnected(), canApprove: await youtube.canApprove() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/twitch/status', admin, async (_req, res, next) => {
  try {
    res.json(await twitch.connectionStatus());
  } catch (error) {
    next(error);
  }
});

app.get('/api/tiktok/status', admin, async (_req, res, next) => {
  try {
    res.json(await tiktok.connectionStatus());
  } catch (error) { next(error); }
});

app.get('/auth/google', admin, async (req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    res.redirect(await youtube.authorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get('/oauth2/callback', async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid OAuth state. Return to the dashboard and try connecting again.');
    if (!req.query.code) return res.status(400).send('Google did not return an authorization code.');
    await youtube.exchangeCode(req.query.code);
    delete req.session.oauthState;
    res.redirect('/?youtube=connected');
  } catch (error) {
    next(error);
  }
});

app.get('/auth/twitch', admin, (req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.twitchOauthState = state;
    res.redirect(twitch.authorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get('/oauth/twitch/callback', async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.session.twitchOauthState) {
      return res.status(400).send('Invalid Twitch OAuth state. Return to the dashboard and try connecting again.');
    }
    if (!req.query.code) return res.status(400).send('Twitch did not return an authorization code.');
    await twitch.exchangeCode(req.query.code);
    delete req.session.twitchOauthState;
    res.redirect('/?twitch=connected');
  } catch (error) {
    next(error);
  }
});

app.get('/auth/tiktok', admin, (req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.tiktokOauthState = state;
    res.redirect(tiktok.authorizationUrl(state));
  } catch (error) { next(error); }
});

app.get('/oauth/tiktok/callback', async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.session.tiktokOauthState) {
      return res.status(400).send('Invalid TikTok OAuth state. Return to the dashboard and try again.');
    }
    if (!req.query.code) return res.status(400).send('TikTok did not return an authorization code.');
    await tiktok.exchangeCode(req.query.code);
    delete req.session.tiktokOauthState;
    res.redirect('/?tiktok=connected');
  } catch (error) { next(error); }
});

app.get('/api/drafts', admin, async (_req, res, next) => {
  try {
    res.json(await store.listDrafts());
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/tiktok-inbox', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.sourceType !== 'twitch_highlight_short' || !draft.youtubeVideoId) {
      return res.status(409).json({ error: 'Only completed stream Shorts can be sent to TikTok' });
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'Review the Short and explicitly consent to this TikTok upload' });
    }
    if (draft.tiktokPublishId && draft.tiktokStatus !== 'failed') {
      return res.status(409).json({ error: 'This Short was already sent to TikTok' });
    }
    if (tiktokJobs.has(draft.id) || draft.tiktokStatus === 'preparing' &&
        Date.now() - Date.parse(draft.tiktokQueuedAt || 0) < 15 * 60 * 1000) {
      return res.status(409).json({ error: 'TikTok delivery is already in progress' });
    }
    const status = await tiktok.connectionStatus();
    if (!status.connected) return res.status(409).json({ error: status.error || 'Connect TikTok first' });
    tiktokJobs.add(draft.id);
    try {
      await store.updateDraft(draft.id, { tiktokStatus: 'preparing', tiktokError: null,
        tiktokPublishId: null, tiktokQueuedAt: new Date().toISOString() });
    } catch (error) { tiktokJobs.delete(draft.id); throw error; }
    setImmediate(() => sendTikTokShort(draft.id));
    res.status(202).json({ accepted: true, tiktokStatus: 'preparing' });
  } catch (error) { next(error); }
});

app.get('/api/drafts/:id/tiktok-status', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.tiktokPublishId) {
      return res.json({ status: draft.tiktokStatus || 'not_sent', error: draft.tiktokError || null });
    }
    const result = await tiktok.fetchStatus(draft.tiktokPublishId);
    const statuses = { SEND_TO_USER_INBOX: 'ready_in_tiktok_inbox', PUBLISH_COMPLETE: 'published', FAILED: 'failed' };
    const status = statuses[result.status] || 'processing_download';
    await store.updateDraft(draft.id, { tiktokStatus: status, tiktokError: result.reason });
    if (status !== 'processing_download') unlinkQuietly(tiktokMediaPath(draft.id));
    res.json({ status, error: result.reason });
  } catch (error) { next(error); }
});

app.post('/api/drafts', agentOrAdmin, upload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A video file is required' });
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 100) return res.status(400).json({ error: 'Title must contain 1–100 characters' });
    const tags = String(req.body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 30);
    const uploaded = await youtube.uploadPrivate({
      filePath: req.file.path,
      title,
      description: String(req.body.description || ''),
      tags,
      madeForKids: req.body.madeForKids === 'true'
    });
    fs.unlink(req.file.path, () => {});
    const draft = await store.addDraft({
      id: crypto.randomUUID(),
      youtubeVideoId: uploaded.id,
      title,
      status: 'awaiting_owner_approval',
      createdAt: new Date().toISOString()
    });
    res.status(201).json(draft);
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(error);
  }
});

app.post('/api/twitch/vod-clips', agentOrAdmin, async (req, res, next) => {
  try {
    const vodId = cleanText(req.body?.vodId, 40);
    if (!/^\d+$/.test(vodId)) return res.status(400).json({ error: 'vodId must be a Twitch VOD number' });
    const twitchStatus = await twitch.connectionStatus();
    if (!twitchStatus.connected) return res.status(409).json({ error: twitchStatus.error || 'Connect Twitch in the Amaana dashboard first' });
    const highlights = normalizeHighlights(req.body?.timestamps);
    const channel = cleanText(req.body?.channel || 'saevond', 50);
    const existingDrafts = await store.listDrafts();
    let batch = existingDrafts.find((draft) => draft.sourceType === 'twitch_highlight_batch' && draft.vodId === vodId);
    if (!batch) {
      batch = await store.addDraft({ id: crypto.randomUUID(), sourceType: 'twitch_highlight_batch',
        sourceChannel: channel, vodId, highlights, streamTitle: cleanText(req.body?.streamTitle, 80),
        title: cleanText(`${req.body?.streamTitle || 'Saevond livestream'} | Best moments`, 100),
        status: 'clip_queued', createdAt: new Date().toISOString() });
      enqueueHighlightBatch(batch.id);
    }
    res.status(202).json({
      accepted: true,
      highlightVideo: { id: batch.id, status: batch.status, title: batch.title },
      shortsPlanned: batch.highlights.length
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/retry', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!['twitch_vod', 'twitch_highlight_batch'].includes(draft.sourceType)
      || (draft.status !== 'clip_failed' && !(draft.sourceType === 'twitch_highlight_batch' && draft.error))) {
      return res.status(409).json({ error: 'Only failed Twitch clip jobs can be retried' });
    }
    const updated = await store.updateDraft(draft.id, { status: 'clip_queued', error: null });
    if (draft.sourceType === 'twitch_highlight_batch') enqueueHighlightBatch(draft.id);
    else enqueueClipProcessing(draft.id);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/approve', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status !== 'awaiting_owner_approval') return res.status(409).json({ error: 'Draft was already handled' });
    const published = await youtube.publish(draft.youtubeVideoId, req.body.publishAt || null);
    const updated = await store.updateDraft(draft.id, {
      status: req.body.publishAt ? 'scheduled' : 'published',
      publishAt: req.body.publishAt || null,
      youtubeUrl: `https://youtu.be/${draft.youtubeVideoId}`
    });
    res.json({ draft: updated, youtube: published.status });
  } catch (error) {
    next(error);
  }
});

app.get('/api/drafts/:id/status', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json(await youtube.getVideo(draft.youtubeVideoId));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error.message);
  const candidate = Number(error.status || error.code);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  res.status(status).json({ error: error.message || 'Unexpected server error' });
});

store.init()
  .then(async () => {
    fs.promises.readdir(uploadDir).then(async (names) => {
      for (const name of names.filter((item) => /^tiktok-[a-f0-9-]{36}\.mp4$/.test(item))) {
        const file = path.join(uploadDir, name);
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 2 * 60 * 60 * 1000) unlinkQuietly(file);
      }
    }).catch(() => {});
    const port = process.env.PORT || 3000;
    app.listen(port, async () => {
      console.log(`AmaanaYt listening on port ${port}`);
      try {
        const drafts = await store.listDrafts();
        const resumable = new Set([
          'clip_queued',
          'creating_twitch_clip',
          'waiting_for_clip_media',
          'downloading_twitch_clip',
          'formatting_vertical_short',
          'uploading_private_to_youtube'
        ]);
        drafts.filter((draft) => draft.sourceType === 'twitch_vod' && resumable.has(draft.status))
          .forEach((draft) => enqueueClipProcessing(draft.id));
        drafts.filter((draft) => draft.sourceType === 'twitch_highlight_batch'
          && ['clip_queued', 'creating_twitch_clips', 'assembling_highlight_video', 'creating_shorts'].includes(draft.status))
          .forEach((draft) => enqueueHighlightBatch(draft.id));
      } catch (error) {
        console.error('Failed to resume Twitch clip jobs:', error.message);
      }
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
