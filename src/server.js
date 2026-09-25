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
  return deduplicated.slice(0, 3);
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
    res.json({ connected: await youtube.isConnected() });
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

app.get('/api/drafts', admin, async (_req, res, next) => {
  try {
    res.json(await store.listDrafts());
  } catch (error) {
    next(error);
  }
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
    const created = [];
    const existingDrafts = await store.listDrafts();
    for (const highlight of highlights) {
      const existing = existingDrafts.find((draft) => draft.sourceType === 'twitch_vod'
        && draft.vodId === vodId
        && Math.abs(Number(draft.endSeconds) - highlight.endSeconds) < 12);
      if (existing) {
        created.push(existing);
        continue;
      }
      const draft = await store.addDraft({
        id: crypto.randomUUID(),
        title: highlight.title,
        status: 'clip_queued',
        sourceType: 'twitch_vod',
        sourceChannel: channel,
        vodId,
        startSeconds: highlight.startSeconds,
        endSeconds: highlight.endSeconds,
        duration: highlight.duration,
        reason: highlight.reason,
        score: highlight.score,
        createdAt: new Date().toISOString()
      });
      created.push(draft);
      existingDrafts.push(draft);
      enqueueClipProcessing(draft.id);
    }
    res.status(202).json({
      accepted: true,
      clips: created.map((draft) => ({ id: draft.id, status: draft.status, title: draft.title }))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/retry', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.sourceType !== 'twitch_vod' || draft.status !== 'clip_failed') {
      return res.status(409).json({ error: 'Only failed Twitch clip jobs can be retried' });
    }
    const updated = await store.updateDraft(draft.id, { status: 'clip_queued', error: null });
    enqueueClipProcessing(draft.id);
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
      } catch (error) {
        console.error('Failed to resume Twitch clip jobs:', error.message);
      }
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
