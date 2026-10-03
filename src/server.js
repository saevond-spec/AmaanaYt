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
const { createShortViewMonitor, TIKTOK_VIEW_THRESHOLD } = require('./short-views');
const { createSeoWorker } = require('./seo-worker');
const { createMonetizationWorker } = require('./monetization-worker');
const { createSeoMarket, detectGame } = require('./seo-market');
const { normalizeContext } = require('./seo-package');
const { buildHighlightTimeline, buildHighlightDescription } = require('./highlight-metadata');
const { auditVideo, channelSuggestions, problem } = require('./seo-publish');
const { createSessionStore } = require('./session-store');
const { canAddVideoToPlaylist } = require('./youtube-playlists');
const { createPlaylistAutoAssigner } = require('./playlist-auto');

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
let sessionMiddleware;
app.use((req, res, next) => sessionMiddleware(req, res, next));
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
const market = createSeoMarket({ store, youtube });
const playlistAuto = createPlaylistAutoAssigner({ store, youtube });
const seo = createSeoWorker({ store, youtube, market, playlistAuto });
const monetization = createMonetizationWorker({ youtube });

async function autoAssignPlaylist(metadata) {
  try {
    return await playlistAuto.assign(metadata);
  } catch (error) {
    console.error('Automatic playlist assignment failed:', error.message);
    return { state: 'retry', reason: String(error.message || 'YouTube request failed').slice(0, 300) };
  }
}

async function autoAssignPublishedPlaylist(videoId, draft) {
  try {
    const video = await youtube.getVideo(videoId);
    if (!video?.snippet) return { state: 'retry', reason: 'Published video metadata is not available yet' };
    return await autoAssignPlaylist({
      id: videoId,
      privacyStatus: video.status?.privacyStatus,
      title: video.snippet.title || draft.title,
      description: video.snippet.description || '',
      tags: video.snippet.tags || [],
      context: draft.context || {}
    });
  } catch (error) {
    console.error('Published video playlist classification failed:', error.message);
    return { state: 'retry', reason: String(error.message || 'Video metadata unavailable').slice(0, 300) };
  }
}
setInterval(() => monetization.schedule(), 5 * 60 * 1000).unref();
const SHORT_VIEW_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let lastShortViewCheck = 0;
let shortViewCheckRunning = false;

async function queueTikTokShort(draft, automatic = false) {
  if (!draft?.tiktokEligible || draft.youtubePrivacyStatus !== 'public' ||
      !Number.isSafeInteger(draft.youtubeViews) || draft.youtubeViews <= TIKTOK_VIEW_THRESHOLD) {
    return false;
  }
  if (draft.tiktokPublishId && draft.tiktokStatus !== 'failed') return false;
  if (tiktokJobs.has(draft.id) || draft.tiktokStatus === 'preparing' &&
      Date.now() - Date.parse(draft.tiktokQueuedAt || 0) < 15 * 60 * 1000) return false;
  if (automatic && (!draft.tiktokAutoSendConsent || draft.tiktokAttemptedAt || tiktokJobs.size)) return false;
  const connection = await tiktok.connectionStatus();
  if (!connection.connected) return false;
  if (automatic) {
    const recent = (await store.listDrafts()).filter((item) => item.tiktokAttemptedAt &&
      Date.now() - Date.parse(item.tiktokAttemptedAt) < 24 * 60 * 60 * 1000);
    if (recent.length >= 5 || recent.some((item) =>
      Date.now() - Date.parse(item.tiktokAttemptedAt) < 55 * 60 * 1000)) return false;
  }
  // The connection check above yields to other requests. Check the local lock again.
  if (tiktokJobs.has(draft.id) || automatic && tiktokJobs.size) return false;
  tiktokJobs.add(draft.id);
  try {
    const claimed = await store.claimTikTokDelivery(draft.id, automatic);
    if (!claimed) { tiktokJobs.delete(draft.id); return false; }
  } catch (error) { tiktokJobs.delete(draft.id); throw error; }
  setImmediate(() => sendTikTokShort(draft.id));
  return true;
}

const shortViews = createShortViewMonitor({ store, youtube, onEligible: async (draft) => {
  try { await queueTikTokShort(draft, true); }
  catch (error) { console.error(`TikTok auto delivery ${draft.id} failed:`, error.message); }
} });

function scheduleShortViewCheck() {
  if (shortViewCheckRunning || Date.now() - lastShortViewCheck < SHORT_VIEW_CHECK_INTERVAL_MS) return;
  lastShortViewCheck = Date.now();
  shortViewCheckRunning = true;
  setImmediate(async () => {
    try { await shortViews.refreshAll(); }
    catch (error) { console.error('YouTube Short view check failed:', error.message); }
    finally { shortViewCheckRunning = false; }
  });
}

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
    const checked = await shortViews.refreshOne(id);
    if (!checked?.tiktokEligible) throw new Error('YouTube Short is no longer public with over 2,000 views');
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

function vodWebhookOrAgentOrAdmin(req, res, next) {
  const key = process.env.VOD_WEBHOOK_KEY;
  if (key && keysMatch(req.get('x-agent-key'), key)) return next();
  return agentOrAdmin(req, res, next);
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
    const playlistAssignment = await autoAssignPlaylist({
      id: uploaded.id, privacyStatus: 'private', title: draft.title, description,
      tags: ['Saevond', 'gaming', 'livestream highlights', 'Shorts'],
      context: { topic: draft.reason || draft.title, takeaways: draft.reason || draft.title, videoType: 'Gameplay' }
    });
    await store.updateDraft(id, {
      playlistAssignment,
      youtubeVideoId: uploaded.id,
      status: 'awaiting_owner_approval',
      error: null,
      processedAt: new Date().toISOString()
    });
    await seo.registerUpload(uploaded.id, {
      title: draft.title, description, tags: ['Saevond', 'gaming', 'livestream highlights', 'Shorts'],
      durationSeconds: draft.duration,
      context: { takeaways: draft.reason || draft.title, videoType: 'Gameplay' },
      markers: [{ kind: 'clip', startSeconds: 0, endSeconds: draft.duration,
        title: draft.title, provenance: 'twitch_highlight' }]
    }).catch((error) => console.error('Short SEO registration failed:', error.message));
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
    const timeline = buildHighlightTimeline(batch.highlights, durations);
    const description = batch.pipelineVersion >= 2
      ? buildHighlightDescription(batch.vodId, timeline)
      : 'Highlights from https://www.twitch.tv/videos/' + batch.vodId;
    const highlightTitle = cleanText((batch.streamTitle || 'Saevond livestream') + ' | Best moments', 100);
    const highlightTags = ['Saevond', 'gaming', 'livestream highlights'];
    const thumbnailPath = path.join(directory, 'highlight-thumbnail.jpg');
    let thumbnailStatus = batch.thumbnailStatus || 'pending';
    let thumbnailError = null;
    let thumbnailHeadline = batch.thumbnailHeadline || '';
    let thumbnailReady = false;
    if (batch.pipelineVersion >= 2 && thumbnailStatus !== 'applied') {
      const selectedIndex = batch.highlights.reduce((best, item, index, all) =>
        (Number(item.score) || 0) > (Number(all[best]?.score) || 0) ? index : best, 0);
      const selected = batch.highlights[selectedIndex];
      const startOffset = durations.slice(0, selectedIndex).reduce((total, value) => total + value, 0);
      const frameOffset = startOffset + Math.min(durations[selectedIndex] / 2,
        Math.max(0.25, durations[selectedIndex] - 0.25));
      thumbnailHeadline = video.thumbnailHeadline(selected.title || highlightTitle);
      try {
        await video.createThumbnail(montage, thumbnailPath, {
          timestampSeconds: frameOffset,
          headline: thumbnailHeadline
        });
        thumbnailReady = true;
        thumbnailStatus = 'generated';
      } catch (error) {
        thumbnailStatus = 'failed';
        thumbnailError = cleanText(error.message, 300);
        console.warn('Thumbnail generation ' + id + ' failed:', error.message);
      }
    }
    const highlight = batch.youtubeVideoId ? { id: batch.youtubeVideoId } : await youtube.uploadPrivate({
      filePath: montage,
      title: highlightTitle,
      description,
      tags: highlightTags
    });
    const playlistAssignment = await autoAssignPlaylist({
      id: highlight.id, privacyStatus: 'private', title: highlightTitle, description,
      tags: highlightTags,
      context: { topic: batch.streamTitle || '', takeaways: batch.highlights.map((moment) =>
        moment.title + ': ' + moment.reason).join('\n'), videoType: 'Gameplay' }
    });
    const highlightPatch = {
      playlistAssignment,
      status: 'creating_shorts',
      youtubeVideoId: highlight.id,
      duration: timeline.durationSeconds
    };
    if (batch.pipelineVersion >= 2) {
      Object.assign(highlightPatch, {
        chapterTimestamps: timeline.timestamps.map(({ time, title }) => ({ time, title })),
        chapters: timeline.chapters.map(({ time, title }) => ({ time, title })),
        chapterStatus: timeline.chapters.length >= 3 ? 'chapters_added' : 'timestamps_only',
        thumbnailStatus,
        thumbnailError,
        thumbnailHeadline
      });
    }
    await store.updateDraft(id, highlightPatch);
    if (batch.pipelineVersion >= 2 && thumbnailReady) {
      try {
        await youtube.setThumbnail(highlight.id, thumbnailPath);
        thumbnailStatus = 'applied';
        thumbnailError = null;
      } catch (error) {
        thumbnailStatus = 'failed';
        thumbnailError = cleanText(error.message, 300);
        console.warn('Thumbnail upload ' + id + ' failed:', error.message);
      }
      await store.updateDraft(id, { thumbnailStatus, thumbnailError, thumbnailHeadline });
    }
    let markerOffset = 0;
    const markers = batch.highlights.flatMap((moment, index) => {
      const length = durations[index];
      const chapter = { kind: 'chapter', startSeconds: markerOffset, title: moment.title, provenance: 'twitch_highlight' };
      const clip = { kind: 'clip', startSeconds: markerOffset, endSeconds: markerOffset + Math.min(60, length),
        title: moment.title, provenance: 'twitch_highlight' };
      markerOffset += length;
      return [chapter, clip];
    });
    await seo.registerUpload(highlight.id, {
      title: highlightTitle,
      description,
      tags: highlightTags,
      durationSeconds: markerOffset,
      context: { topic: batch.streamTitle || '', takeaways: batch.highlights.map((moment) =>
        moment.title + ': ' + moment.reason).join('\n'), videoType: 'Gameplay' },
      markers
    }).catch((error) => console.error('Highlight SEO registration failed:', error.message));

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
        const shortDescription = (moment.reason || 'Livestream highlight') +
          '\n\nHighlight video: https://youtu.be/' + highlight.id + '\n#Saevond #Shorts';
        const shortTags = ['Saevond', 'gaming', 'Shorts'];
        const uploaded = await youtube.uploadPrivate({ filePath: shortPath, title: moment.title,
          description: shortDescription, tags: shortTags });
        const playlistAssignment = await autoAssignPlaylist({
          id: uploaded.id, privacyStatus: 'private', title: moment.title, description: shortDescription,
          tags: shortTags,
          context: { takeaways: moment.reason || moment.title, videoType: 'Gameplay' }
        });
        await store.addDraft({ id: crypto.randomUUID(), sourceType: 'twitch_highlight_short', parentId: id, highlightIndex: index,
          vodId: batch.vodId, title: moment.title, youtubeVideoId: uploaded.id, playlistAssignment,
          status: 'awaiting_owner_approval', createdAt: new Date().toISOString() });
        await seo.registerUpload(uploaded.id, {
          title: moment.title, description: shortDescription, tags: shortTags,
          durationSeconds: length, context: { takeaways: moment.reason || moment.title, videoType: 'Gameplay' },
          markers: [{ kind: 'clip', startSeconds: 0, endSeconds: length,
            title: moment.title, provenance: 'twitch_highlight' }]
        }).catch((error) => console.error('Stream Short SEO registration failed:', error.message));
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
    scheduleShortViewCheck();
    seo.schedule();
    monetization.schedule();
    market.schedule();
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

app.get('/api/seo/status', admin, async (_req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await seo.status()); }
  catch (error) { next(error); }
});

app.get('/api/monetization/status', admin, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(monetization.status());
});

app.get('/api/seo/market', admin, async (req, res, next) => {
  try {
    const game = detectGame({ title: String(req.query.game || '') });
    if (!game) return res.status(400).json({ error: 'Recognized game is required' });
    res.set('Cache-Control', 'no-store');
    res.json({ game, snapshot: await store.getSeoMarketSnapshot(game) });
  } catch (error) { next(error); }
});

app.get('/api/seo/videos', admin, async (req, res, next) => {
  try {
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    if (!Number.isSafeInteger(offset)) return res.status(400).json({ error: 'Invalid offset' });
    res.set('Cache-Control', 'no-store');
    res.json((await store.listSeoVideos(50, offset)).map((item) => ({
      ...item, audit: auditVideo(item)
    })));
  } catch (error) { next(error); }
});

app.get('/api/seo/channel', admin, async (_req, res, next) => {
  try {
    const [channel, state, videos] = await Promise.all([
      youtube.channelSeo(), store.getSeoSyncState(), store.listSeoVideos(100)
    ]);
    if (state.channelId && state.channelId !== channel.id) {
      throw problem('Connected channel differs from the SEO catalog. Rescan before editing.', 409);
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      id: channel.id, title: channel.title, description: channel.description,
      keywords: channel.keywords,
      suggestions: channelSuggestions(videos.filter((video) => video.source?.channelId === channel.id)),
      audit: [
        ...(!channel.description.trim() ? ['Channel description is empty.'] :
          channel.description.trim().length < 80 ? ['Channel description is brief; review its topic and audience.'] : []),
        ...(!channel.keywords.trim() ? ['No channel keywords are set.'] : [])
      ]
    });
  } catch (error) { next(error); }
});

app.post('/api/seo/backfill', admin, async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    res.json(await seo.setBackfill(req.body.enabled, req.body.restart === true));
  } catch (error) { next(error); }
});

app.put('/api/seo/videos/:id/context', admin, async (req, res, next) => {
  try {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID' });
    const current = await store.getSeoVideo(req.params.id);
    if (!current) return res.status(404).json({ error: 'Video not found in the channel catalog' });
    const context = normalizeContext(req.body, current.source.durationSeconds);
    await store.updateSeoContext(req.params.id, context);
    seo.schedule(true);
    res.json({ queued: true, videoId: req.params.id });
  } catch (error) {
    if (error.message.startsWith('Marker ') || error.message.startsWith('markers ') ||
        error.message.startsWith('Primary keyword ')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.post('/api/seo/videos/:id/regenerate', admin, async (req, res, next) => {
  try {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID' });
    const current = await store.getSeoVideo(req.params.id);
    if (!current) return res.status(404).json({ error: 'Video not found in the channel catalog' });
    await store.updateSeoContext(req.params.id, current.context);
    seo.schedule(true);
    res.json({ queued: true, videoId: req.params.id });
  } catch (error) { next(error); }
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
    seo.schedule(true);
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
    scheduleShortViewCheck();
    res.json(await store.listDrafts());
  } catch (error) {
    next(error);
  }
});

app.get('/api/youtube/playlists', admin, async (_req, res, next) => {
  try { res.json(await youtube.listOwnedPlaylists()); }
  catch (error) { next(error); }
});

app.post('/api/youtube/playlists', admin, async (req, res, next) => {
  try {
    const playlist = await youtube.createPlaylist(req.body || {});
    playlistAuto.invalidatePlaylists();
    if (playlist.privacyStatus === 'public') await store.resetSeoPlaylistResults();
    seo.schedule(true);
    res.status(201).json(playlist);
  } catch (error) { next(error); }
});

app.post('/api/youtube/playlists/:playlistId/items', admin, async (req, res, next) => {
  try {
    const videoId = String(req.body?.videoId || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'A valid 11-character YouTube video ID is required' });
    }
    const playlists = await youtube.listOwnedPlaylists();
    const playlist = playlists.find((item) => item.id === req.params.playlistId);
    if (!playlist) return res.status(404).json({ error: 'Choose a playlist owned by the connected YouTube channel' });
    const [channel, video] = await Promise.all([youtube.ownedChannel(), youtube.getVideo(videoId)]);
    if (!video?.snippet?.channelId) return res.status(404).json({ error: 'YouTube video not found' });
    if (video.snippet.channelId !== channel.id) {
      return res.status(403).json({ error: 'Only videos from the connected channel can be added' });
    }
    if (!canAddVideoToPlaylist(video.status?.privacyStatus, playlist.privacyStatus)) {
      return res.status(409).json({ error: 'Private and unlisted videos can only be added to a private playlist' });
    }
    const result = await youtube.addVideoToPlaylist({ playlistId: playlist.id, videoId });
    res.json({ success: true, alreadyAdded: result.alreadyAdded, itemId: result.itemId,
      playlist: { id: playlist.id, title: playlist.title, privacyStatus: playlist.privacyStatus } });
  } catch (error) { next(error); }
});

app.get('/api/shorts/eligible', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    scheduleShortViewCheck();
    const drafts = await store.listDrafts();
    res.json(drafts.filter((draft) => draft.sourceType === 'twitch_highlight_short'
      && draft.youtubePrivacyStatus === 'public' && draft.tiktokEligible
      && draft.youtubeViews > TIKTOK_VIEW_THRESHOLD).map((draft) => ({
      title: draft.title,
      youtubeUrl: `https://youtu.be/${draft.youtubeVideoId}`,
      views: draft.youtubeViews,
      eligibleAt: draft.tiktokEligibleAt
    })));
  } catch (error) { next(error); }
});

app.get('/api/drafts/:id/youtube-views', admin, async (req, res, next) => {
  try {
    const updated = await shortViews.refreshOne(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Stream Short not found' });
    res.json({ views: updated.youtubeViews, privacyStatus: updated.youtubePrivacyStatus,
      eligible: updated.tiktokEligible, checkedAt: updated.youtubeViewsCheckedAt });
  } catch (error) { next(error); }
});

app.post('/api/drafts/:id/tiktok-auto', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.sourceType !== 'twitch_highlight_short' || !draft.youtubeVideoId) {
      return res.status(409).json({ error: 'Only completed stream Shorts can be sent to TikTok' });
    }
    if (draft.tiktokPublishId || draft.tiktokAttemptedAt) {
      return res.status(409).json({ error: 'TikTok delivery was already attempted for this Short' });
    }
    if (req.body?.consent !== true && req.body?.consent !== false) {
      return res.status(400).json({ error: 'Explicit consent is required for this Short' });
    }
    if (req.body.consent) {
      const status = await tiktok.connectionStatus();
      if (!status.connected) return res.status(409).json({ error: status.error || 'Connect TikTok first' });
    }
    const updated = await store.updateDraft(draft.id, {
      tiktokAutoSendConsent: req.body.consent,
      tiktokAutoSendAt: req.body.consent ? new Date().toISOString() : null
    });
    if (req.body.consent) {
      // Consent remains saved if YouTube is temporarily unavailable; the hourly check will retry.
      try { await shortViews.refreshOne(draft.id); }
      catch (error) { console.error(`Short view check ${draft.id} failed:`, error.message); }
    }
    res.json({ consent: updated.tiktokAutoSendConsent });
  } catch (error) { next(error); }
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
    const checked = await shortViews.refreshOne(draft.id);
    if (!checked?.tiktokEligible) {
      return res.status(409).json({ error: 'This public YouTube Short must exceed 2,000 views before TikTok delivery' });
    }
    if (!await queueTikTokShort(checked)) {
      return res.status(409).json({ error: 'Connect TikTok or wait for the current delivery to finish' });
    }
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
    if (!title || title.length > 100) {
      unlinkQuietly(req.file.path);
      return res.status(400).json({ error: 'Title must contain 1–100 characters' });
    }
    const tags = String(req.body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 30);
    let markers = [];
    if (req.body.markers) {
      try { markers = JSON.parse(req.body.markers); }
      catch { unlinkQuietly(req.file.path); return res.status(400).json({ error: 'markers must be a JSON array' }); }
    }
    let context;
    try {
      context = normalizeContext({ topic: req.body.topic, primaryKeyword: req.body.primaryKeyword,
        takeaways: req.body.takeaways, audience: req.body.audience, videoType: req.body.videoType,
        markers }, null);
    } catch (error) {
      unlinkQuietly(req.file.path);
      return res.status(400).json({ error: error.message });
    }
    const uploaded = await youtube.uploadPrivate({
      filePath: req.file.path,
      title,
      description: String(req.body.description || ''),
      tags,
      madeForKids: req.body.madeForKids === 'true'
    });
    const playlistAssignment = await autoAssignPlaylist({
      id: uploaded.id, privacyStatus: 'private', title,
      description: String(req.body.description || ''), tags, context
    });
    fs.unlink(req.file.path, () => {});
    const draft = await store.addDraft({
      id: crypto.randomUUID(),
      youtubeVideoId: uploaded.id,
      title,
      playlistAssignment,
      status: 'awaiting_owner_approval',
      createdAt: new Date().toISOString()
    });
    await seo.registerUpload(uploaded.id, { title, description: String(req.body.description || ''),
      tags, context }).catch((error) => console.error('Upload SEO registration failed:', error.message));
    res.status(201).json(draft);
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(error);
  }
});

app.post('/api/twitch/vod-clips', vodWebhookOrAgentOrAdmin, async (req, res, next) => {
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
        pipelineVersion: 2, thumbnailStatus: 'pending',
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
    const playlistAssignment = req.body.publishAt
      ? draft.playlistAssignment
      : await autoAssignPublishedPlaylist(draft.youtubeVideoId, draft);
    const updated = await store.updateDraft(draft.id, {
      playlistAssignment,
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
    const sessionStore = await createSessionStore({ pool: store.pool, redisUrl: process.env.REDIS_URL });
    sessionMiddleware = session({
      store: sessionStore,
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 60 * 1000 }
    });
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
      scheduleShortViewCheck();
      seo.schedule();
      monetization.schedule();
      market.schedule();
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
