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

function admin(req, res, next) {
  if (req.session?.adminAuthenticated || keysMatch(req.get('x-admin-key'), process.env.ADMIN_KEY)) return next();
  return res.status(401).json({ error: 'Owner approval required' });
}

function agentOrAdmin(req, res, next) {
  if (req.session?.adminAuthenticated || keysMatch(req.get('x-admin-key'), process.env.ADMIN_KEY)) return next();
  return agentKey(req, res, next);
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
  res.status(error.code || 500).json({ error: error.message || 'Unexpected server error' });
});

store.init()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log(`AmaanaYt listening on port ${process.env.PORT || 3000}`)))
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
