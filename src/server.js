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

for (const name of ['BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'AGENT_KEY', 'ADMIN_KEY']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const app = express();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
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
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000
  }
}));

function keyGuard(environmentName, message) {
  return (req, res, next) => {
    const supplied = req.get(environmentName === 'ADMIN_KEY' ? 'x-admin-key' : 'x-agent-key');
    const expected = process.env[environmentName];
    const a = Buffer.from(String(supplied || ''));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: message });
    }
    next();
  };
}

const agent = keyGuard('AGENT_KEY', 'Agent key required');
const admin = keyGuard('ADMIN_KEY', 'Owner approval key required');

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/auth/google', admin, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  res.redirect(youtube.authorizationUrl(state));
});

app.get('/oauth2/callback', async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send('Invalid OAuth state');
    }
    await youtube.exchangeCode(req.query.code);
    delete req.session.oauthState;
    res.send('YouTube connected. You may close this page.');
  } catch (error) {
    next(error);
  }
});

app.get('/api/drafts', admin, (_req, res) => res.json(store.listDrafts()));

app.post('/api/drafts', agent, upload.single('video'), async (req, res, next) => {
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
    const draft = store.addDraft({
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
    const draft = store.listDrafts().find((item) => item.id === req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status !== 'awaiting_owner_approval') return res.status(409).json({ error: 'Draft was already handled' });
    const published = await youtube.publish(draft.youtubeVideoId, req.body.publishAt || null);
    const updated = store.updateDraft(draft.id, {
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
    const draft = store.listDrafts().find((item) => item.id === req.params.id);
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

app.listen(process.env.PORT || 3000, () => {
  console.log(`AmaanaYt listening on port ${process.env.PORT || 3000}`);
});
