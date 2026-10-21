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
const { createChannelTagWorker } = require('./channel-tag-worker');
const { createMonetizationWorker } = require('./monetization-worker');
const { createSeoMarket, detectGame } = require('./seo-market');
const { normalizeContext } = require('./seo-package');
const { normalizeJapaneseChannelLocalization, suggestJapaneseChannelLocalization } = require('./channel-localization');
const { createJapaneseLocalizationWorker } = require('./japanese-localization-worker');
const { hasVerifiedGameplayHighlight, hasVerifiedLiveGameplayClip } = require('./highlight-validation');
const { buildHighlightTimeline, buildHighlightDescription } = require('./highlight-metadata');
const { createBatchQueue, createHighlightProcessor, findDueHighlightRetries, isTransientError,
  shouldPullForwardTwitchMetadataRetry, shouldRequeueUnexpectedTwitchDownloadHost,
  shouldPullForwardAllowedTwitchDownloadHost, shouldRequeueTwitchSegmentDurationFailure } = require('./highlight-pipeline');
const { createTwitchHighlightDiscovery } = require('./twitch-highlight-discovery');
const { clipRetryDelayMs, isRetryableCommunityClipError, isVerifiedGameplayResult, reuseOrVerifyGameplay } = require('./twitch-community-clips');
const { collectTestVodDrafts } = require('./gameplay-intake-guard');
const { auditVideo, channelSuggestions, problem, assertVideoMatchesCatalog } = require('./seo-publish');
const { createSessionStore } = require('./session-store');
const { canAddVideoToPlaylist } = require('./youtube-playlists');
const { parseGoogleSearchConsoleCsv } = require('./google-search-console');
const { createPlaylistAutoAssigner } = require('./playlist-auto');
const { isYouTubeUploadLimitError, isDefiniteYouTubeUploadRejection,
  isRetryableYouTubeUploadRejection, isUploadRetryCoolingDown,
  buildUploadReconciliationPatch, canRetryTwitchDraft,
  recoverInterruptedYouTubeUploads, findDueTwitchVodRetries,
  findDueTwitchHighlightRetryParents, claimDueTwitchHighlightRetryParents,
  YOUTUBE_UPLOAD_LIMIT_RETRY_MS } = require('./draft-recovery');
const { initializeWithRetry } = require('./retryable-initializer');

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
const googleSearchCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

function uploadGoogleSearchCsv(req, res, next) {
  googleSearchCsvUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: error.code === 'LIMIT_FILE_SIZE'
        ? 'CSV upload must be 5 MB or smaller'
        : 'Upload one Search Console CSV file' });
  });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(String(value) + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
let sessionMiddleware;
app.use((req, res, next) => sessionMiddleware(req, res, next));
app.use(express.static(publicDir, {
  index: false,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (['.js', '.css'].includes(path.extname(filePath))) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

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
const channelTagWorker = createChannelTagWorker({ store, youtube });
setInterval(() => channelTagWorker.schedule(), 5 * 60 * 1000).unref?.();
const japaneseLocalizationWorker = createJapaneseLocalizationWorker({ store, youtube });
setInterval(() => japaneseLocalizationWorker.schedule(), 15 * 60 * 1000).unref?.();
japaneseLocalizationWorker.getState().then((state) => {
  if (state.enabled) japaneseLocalizationWorker.schedule(true);
}).catch((error) => console.error('Japanese localization autopilot startup check failed:', error.message));
const seo = createSeoWorker({ store, youtube, market, playlistAuto });
const monetization = createMonetizationWorker({ store, youtube });
const configuredHighlightAttempts = Number(process.env.HIGHLIGHT_MAX_AUTO_ATTEMPTS);
const highlightMaxAutoAttempts = Number.isSafeInteger(configuredHighlightAttempts) && configuredHighlightAttempts > 0
  ? Math.min(configuredHighlightAttempts, 24) : 12;
const configuredTwitchClipAttempts = Number(process.env.TWITCH_CLIP_MAX_AUTO_ATTEMPTS);
const twitchClipMaxAutoAttempts = Number.isSafeInteger(configuredTwitchClipAttempts) && configuredTwitchClipAttempts > 0
  ? Math.min(configuredTwitchClipAttempts, 24) : 8;

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
    const url = download.landscape_download_url;
    if (!url) throw new Error('Twitch clip has no landscape gameplay source; portrait-only Twitch media is rejected');
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

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function unlinkQuietly(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

async function processTwitchClipDraft(id, queueOptions = {}) {
  let sourcePath;
  let shortPath;
  let claimToken = String(queueOptions?.retryLeaseClaimToken || '');
  let leaseHeartbeat = null;
  const ownsLease = async () => {
    if (!claimToken) return false;
    const current = await store.getDraft(id);
    const leaseUntil = Date.parse(current?.retryLeaseUntil || '');
    return Boolean(current && current.status !== 'excluded_by_owner' &&
      current.productionState !== 'excluded' && !current.excludedAt &&
      current.retryLeaseClaimToken === claimToken &&
      Number.isFinite(leaseUntil) && leaseUntil > Date.now());
  };
  const updateClaimedDraft = async (patch) => {
    if (!claimToken || typeof store.updateDraftWithRetryLease !== 'function') {
      throw Object.assign(new Error('Claimed Twitch VOD updates are unavailable'), {
        code: 'HIGHLIGHT_RETRY_LEASE_LOST'
      });
    }
    const updated = await store.updateDraftWithRetryLease(id, claimToken, patch);
    if (!updated) throw Object.assign(new Error('Twitch VOD retry lease was lost'), {
      code: 'HIGHLIGHT_RETRY_LEASE_LOST'
    });
    return updated;
  };
  try {
    let draft = await store.getDraft(id);
    if (!draft || draft.sourceType !== 'twitch_vod' || draft.status === 'awaiting_owner_approval' ||
        draft.status === 'excluded_by_owner' || draft.productionState === 'excluded' || draft.excludedAt) return;
    if (draft.youtubeVideoId) {
      await store.updateDraft(id, { status: 'awaiting_owner_approval',
        productionState: 'ready', error: null, nextClipAttemptAt: null });
      return;
    }
    if (Number(draft.clipAttemptCount || 0) >= twitchClipMaxAutoAttempts) {
      await store.updateDraft(id, {
        status: 'clip_failed', productionState: 'manual_review',
        error: 'Automatic Twitch clip attempt limit reached; owner review is required.',
        nextClipAttemptAt: null
      });
      return;
    }
    if (typeof store.claimTwitchVodDraft !== 'function') {
      throw new Error('Durable Twitch VOD claims are unavailable; refusing to process this clip');
    }
    if (claimToken) {
      const leaseUntil = Date.parse(draft.retryLeaseUntil || '');
      if (draft.retryLeaseClaimToken !== claimToken ||
          !Number.isFinite(leaseUntil) || leaseUntil <= Date.now()) return;
    } else {
      draft = await store.claimTwitchVodDraft(id, {
        maxAttempts: twitchClipMaxAutoAttempts, leaseMs: 15 * 60 * 1000
      });
      if (!draft) return;
      claimToken = draft.retryLeaseClaimToken;
    }
    if (!claimToken) return;
    leaseHeartbeat = setInterval(() => {
      store.extendHighlightRetryLease(id, claimToken, 15 * 60 * 1000)
        .catch((error) => console.error('Failed to extend Twitch VOD retry lease ' + id + ':', error.message));
    }, 5 * 60 * 1000);
    leaseHeartbeat.unref?.();

    if (draft.status === 'creating_twitch_clip' && !draft.twitchClipId) {
      await updateClaimedDraft( {
        status: 'clip_failed', productionState: 'manual_review', nextClipAttemptAt: null,
        error: 'Twitch clip creation may have completed before this worker stopped. Check Twitch clips before retrying.'
      });
      return;
    }
    draft = await updateClaimedDraft( {
      clipAttemptCount: (Number(draft.clipAttemptCount) || 0) + 1,
      lastClipAttemptAt: new Date().toISOString()
    });
    if (!draft || !await ownsLease()) return;
    if (draft.discoverySource === 'twitch_live_capture' && !hasVerifiedLiveGameplayClip(draft)) {
      throw new Error('Live Twitch clip did not pass gameplay verification; no YouTube upload was made');
    }
    if (!await twitch.isConnected()) throw new Error('Connect Twitch in Amaana before processing VOD highlights');

    if (!draft.twitchClipId) {
      draft = await updateClaimedDraft( { status: 'creating_twitch_clip', error: null });
      if (!draft || !await ownsLease()) return;
      const clip = await twitch.createClipFromVod({
        vodId: draft.vodId,
        vodOffset: draft.endSeconds,
        duration: draft.duration,
        title: draft.title
      });
      draft = await updateClaimedDraft( {
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
    const landscapeUrl = download.landscape_download_url;
    if (!landscapeUrl) throw new Error('Twitch clip has no landscape gameplay source; portrait-only Twitch media is rejected');

    sourcePath = path.join(uploadDir, `${id}-source.mp4`);
    shortPath = path.join(uploadDir, `${id}-short.mp4`);
    await Promise.all([
      fs.promises.rm(sourcePath, { force: true }),
      fs.promises.rm(shortPath, { force: true })
    ]);
    await updateClaimedDraft( { status: 'downloading_twitch_clip' });
    await twitch.downloadClip(landscapeUrl, sourcePath);
    if (draft.discoverySource === 'twitch_community_clip') {
      const reusableGameplay = isVerifiedGameplayResult(draft.visualGameplayVerification);
      if (typeof video.inspectMedia !== 'function' || (!reusableGameplay &&
          (process.env.ENABLE_GAMEPLAY_SCREENING !== 'true' || !process.env.VIDEO_ANALYSIS_API_KEY ||
           typeof video.verifyGameplay !== 'function'))) {
        throw new Error('Community Twitch clip is held because visual gameplay verification is unavailable');
      }
      const media = await video.inspectMedia(sourcePath);
      const width = Number(media && media.width);
      const height = Number(media && media.height);
      const mediaDuration = Number(media && media.durationSeconds);
      if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0 || width / height < 1.6 ||
          !Number.isFinite(mediaDuration) || Math.abs(mediaDuration - Number(draft.duration)) > 2) {
        throw new Error('Community Twitch clip failed landscape media validation');
      }
      const { gameplay, reused } = await reuseOrVerifyGameplay(
        draft.visualGameplayVerification, () => video.verifyGameplay(sourcePath));
      if (!reused) {
        draft = await updateClaimedDraft( {
          visualGameplayVerification: { ...gameplay, media, verifiedAt: new Date().toISOString() }
        });
      }
    }
    await updateClaimedDraft( { status: 'formatting_vertical_short' });
    await video.convertLandscapeToShort(sourcePath, shortPath);
    if (typeof video.validateShort !== 'function') {
      throw new Error('Rendered Twitch Short cannot be validated; no YouTube upload was made');
    }
    await video.validateShort(shortPath, draft.duration);

    const uploadReservation = await updateClaimedDraft( { status: 'uploading_private_to_youtube' });
    if (!uploadReservation || !await ownsLease()) return;
    const hasVodTimestamp = /^\d+$/.test(String(draft.vodId || '')) && Number.isFinite(Number(draft.startSeconds));
    const sourceUrl = hasVodTimestamp
      ? 'https://www.twitch.tv/videos/' + draft.vodId + '?t=' + Math.floor(draft.startSeconds) + 's'
      : draft.twitchUrl || 'https://clips.twitch.tv/' + draft.twitchClipId;
    const description = [
      draft.reason || (draft.discoverySource === 'twitch_community_clip'
        ? 'Gameplay-verified community clip from a Saevond livestream.'
        : 'AI-detected highlight from a Saevond livestream.'),
      '',
      `Full Twitch VOD: ${sourceUrl}`,
      '',
      '#Saevond #Gaming #Shorts'
    ].join('\n');
    const uploaded = await youtube.uploadPrivate({
      filePath: shortPath,
      title: draft.title,
      description,
      tags: ['@saevond', 'gaming', 'livestream highlights', 'Shorts'],
      madeForKids: false
    });
    await updateClaimedDraft( {
      youtubeVideoId: uploaded.id,
      status: 'awaiting_owner_approval',
      error: null,
      processedAt: new Date().toISOString()
    });
    const playlistAssignment = await autoAssignPlaylist({
      id: uploaded.id, privacyStatus: 'private', title: draft.title, description,
      tags: ['@saevond', 'gaming', 'livestream highlights', 'Shorts'],
      context: { topic: draft.reason || draft.title, takeaways: draft.reason || draft.title, videoType: 'Gameplay' }
    });
    await updateClaimedDraft( {
      playlistAssignment,
      youtubeVideoId: uploaded.id,
      status: 'awaiting_owner_approval',
      error: null,
      processedAt: new Date().toISOString()
    });
    await seo.registerUpload(uploaded.id, {
      title: draft.title, description, tags: ['@saevond', 'gaming', 'livestream highlights', 'Shorts'],
      durationSeconds: draft.duration,
      context: { takeaways: draft.reason || draft.title, videoType: 'Gameplay' },
      markers: [{ kind: 'clip', startSeconds: 0, endSeconds: draft.duration,
        title: draft.title, provenance: 'twitch_highlight' }],
      playlistAssignment
    }).catch((error) => console.error('Short SEO registration failed:', error.message));
  } catch (error) {
    if (error?.code === 'HIGHLIGHT_RETRY_LEASE_LOST') return;
    console.error(`Twitch clip job ${id} failed:`, error.message);
    const latest = await store.getDraft(id).catch(() => null);
    const uploadInProgress = latest?.status === 'uploading_private_to_youtube';
    const uploadLimitRejected = isYouTubeUploadLimitError(error);
    const definiteUploadRejection = isDefiniteYouTubeUploadRejection(error);
    const retryableUploadRejection = isRetryableYouTubeUploadRejection(error);
    if (latest && latest.youtubeVideoId) {
      await updateClaimedDraft( { status: 'awaiting_owner_approval',
        productionState: 'ready', error: null, nextClipAttemptAt: null }).catch(() => {});
    } else if (uploadInProgress && uploadLimitRejected &&
        Number(latest?.clipAttemptCount || 0) < twitchClipMaxAutoAttempts) {
      await updateClaimedDraft( {
        status: 'clip_retry_wait', productionState: 'retry_scheduled',
        nextClipAttemptAt: new Date(Date.now() + YOUTUBE_UPLOAD_LIMIT_RETRY_MS).toISOString(),
        error: 'YouTube rejected this upload because the channel upload limit was reached. A retry is queued after a conservative 24-hour wait.'
      }).catch(() => {});
    } else if (uploadInProgress && definiteUploadRejection && retryableUploadRejection &&
        Number(latest?.clipAttemptCount || 0) < twitchClipMaxAutoAttempts) {
      const delay = Math.max(Number(error.retryAfterMs) || 0, clipRetryDelayMs(
        Math.max(1, Number(latest.clipAttemptCount) || 1), id));
      await updateClaimedDraft( {
        status: 'clip_retry_wait', productionState: 'retry_scheduled',
        nextClipAttemptAt: new Date(Date.now() + delay).toISOString(),
        error: cleanText(error.message, 500)
      }).catch(() => {});
    } else if (uploadInProgress && definiteUploadRejection) {
      await updateClaimedDraft( {
        status: 'clip_failed', productionState: 'failed', nextClipAttemptAt: null,
        error: cleanText(error.message, 500)
      }).catch(() => {});
    } else if (uploadInProgress) {
      await updateClaimedDraft( {
        status: 'clip_upload_uncertain', productionState: 'manual_reconciliation',
        error: cleanText(error.message, 500), nextClipAttemptAt: null
      }).catch(() => {});
    } else if (latest && latest.discoverySource === 'twitch_community_clip' &&
        Number(latest.clipAttemptCount || 0) < twitchClipMaxAutoAttempts && isRetryableCommunityClipError(error)) {
      const attempt = Math.max(1, Number(latest.clipAttemptCount) || 1);
      const delay = Math.max(Number(error.retryAfterMs) || 0, clipRetryDelayMs(attempt, id));
      const nextClipAttemptAt = new Date(Date.now() + delay).toISOString();
      await updateClaimedDraft( {
        status: 'clip_retry_wait', productionState: 'retry_scheduled', nextClipAttemptAt,
        error: cleanText(error.message, 500)
      }).catch(() => {});
    } else if (latest && Number(latest.clipAttemptCount || 0) < twitchClipMaxAutoAttempts && isTransientError(error)) {
      const attempt = Math.max(1, Number(latest.clipAttemptCount) || 1);
      const delay = Math.max(Number(error.retryAfterMs) || 0, clipRetryDelayMs(attempt, id));
      await updateClaimedDraft( {
        status: 'clip_retry_wait', productionState: 'retry_scheduled',
        nextClipAttemptAt: new Date(Date.now() + delay).toISOString(),
        error: cleanText(error.message, 500)
      }).catch(() => {});
    } else {
      await updateClaimedDraft( { status: 'clip_failed', error: cleanText(error.message, 500) }).catch(() => {});
    }
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (claimToken && typeof store.releaseHighlightRetryLease === 'function') {
      await store.releaseHighlightRetryLease(id, claimToken).catch((error) =>
        console.error('Failed to release Twitch VOD retry lease ' + id + ':', error.message));
    }
    unlinkQuietly(sourcePath);
    unlinkQuietly(shortPath);
  }
}

async function runClipQueue() {
  if (clipWorkerRunning) return;
  clipWorkerRunning = true;
  try {
    while (clipQueue.length) {
      const job = clipQueue.shift();
      try { await processTwitchClipDraft(job.id, job.options); } finally { queuedClipIds.delete(job.id); }
    }
  } finally {
    clipWorkerRunning = false;
  }
}

function enqueueClipProcessing(id, options = null) {
  const value = String(id);
  if (queuedClipIds.has(value)) {
    const pending = clipQueue.find((job) => job.id === value);
    if (pending && options?.retryLeaseClaimToken) {
      pending.options = { ...(pending.options || {}), ...options };
      return true;
    }
    return false;
  }
  queuedClipIds.add(value);
  clipQueue.push({ id: value, options });
  setImmediate(() => runClipQueue().catch((error) => console.error('Clip queue failed:', error.message)));
  return true;
}

const processHighlightBatch = createHighlightProcessor({
  uploadDir, store, twitch, video, youtube, seo, autoAssignPlaylist,
  buildHighlightTimeline, buildHighlightDescription, cleanText,
  maxAutoAttempts: highlightMaxAutoAttempts,
  // Newly produced Twitch bundles stay private until the owner publishes from review.
  autoPublish: false,
  logError: (id, error) => console.error('Highlight batch ' + id + ' failed:', error.message),
  logSuccess: (id, shorts) => console.info('Amaana Twitch highlight batch ' + id +
    ' is ready for owner review with ' + shorts + ' Shorts')
});const highlightBatchQueue = createBatchQueue(processHighlightBatch, {
  onError: (id, error) => console.error('Highlight batch queue failed for ' + id + ':', error.message)
});
function enqueueHighlightBatch(id, options = null) {
  return highlightBatchQueue.enqueue(id, options);
}
const twitchHighlightDiscovery = createTwitchHighlightDiscovery({
  twitch, store, video, enqueueBatch: enqueueHighlightBatch, enqueueClip: enqueueClipProcessing,
  visualGameplayVerificationAvailable: () => process.env.ENABLE_GAMEPLAY_SCREENING === 'true' &&
    Boolean(process.env.VIDEO_ANALYSIS_API_KEY)
});
let highlightRetryScanRunning = false;
async function scheduleDueHighlightRetries() {
  if (highlightRetryScanRunning) return;
  highlightRetryScanRunning = true;
  try {
    const drafts = await store.listDrafts();
    const timestamp = Date.now();
    const dueTwitchVodRetryDrafts = findDueTwitchVodRetries(
      drafts, timestamp, twitchClipMaxAutoAttempts
    );
    const dueTwitchVodRetryIds = new Set(dueTwitchVodRetryDrafts.map((draft) => draft.id));
    const claimedTwitchVodRetries = [];
    for (const candidate of dueTwitchVodRetryDrafts) {
      try {
        const claimed = await store.claimTwitchVodDraft(candidate.id, {
          now: timestamp, maxAttempts: twitchClipMaxAutoAttempts, leaseMs: 15 * 60 * 1000
        });
        if (claimed) claimedTwitchVodRetries.push(claimed);
      } catch (error) {
        console.error('Failed to claim Twitch VOD retry ' + candidate.id + ': ' + error.message);
      }
    }
    for (const draft of claimedTwitchVodRetries) {
      const claimToken = draft.retryLeaseClaimToken;
      try {
        const accepted = enqueueClipProcessing(draft.id, { retryLeaseClaimToken: claimToken });
        if (!accepted && typeof store.releaseHighlightRetryLease === 'function') {
          await store.releaseHighlightRetryLease(draft.id, claimToken);
        }
      } catch (error) {
        console.error('Failed to queue or release Twitch VOD retry ' + draft.id + ': ' + error.message);
      }
    }
    const claimedShortRetryParents = await claimDueTwitchHighlightRetryParents(
      drafts,
      (id, claimOptions) => store.claimHighlightRetryParent(id, claimOptions),
      { now: timestamp, maxAttempts: highlightMaxAutoAttempts,
        onError: (error, parent) => console.error(
          'Failed to persist retry lease for highlight batch ' + parent.id + ': ' + error.message) }
    );
    for (const parent of claimedShortRetryParents) {
      const claimToken = parent.retryLeaseClaimToken;
      try {
        const accepted = enqueueHighlightBatch(parent.id, {
          retryLeaseClaimToken: claimToken
        });
        if (!accepted && typeof store.releaseHighlightRetryLease === 'function') {
          await store.releaseHighlightRetryLease(parent.id, claimToken);
          console.warn('Released highlight retry lease after an active queue duplicate: ' + parent.id);
        }
      } catch (error) {
        console.error('Failed to queue or release highlight retry ' + parent.id + ': ' + error.message);
      }
    }
    for (const draft of drafts) {
      if (draft.sourceType === 'twitch_highlight_batch' &&
          Number(draft.clipAttemptCount || 0) >= highlightMaxAutoAttempts) continue;
      if (dueTwitchVodRetryIds.has(draft.id)) continue;
      if (shouldRequeueTwitchSegmentDurationFailure(draft)) {
        const retryAt = new Date(timestamp).toISOString();
        await store.updateDraft(draft.id, {
          status: 'clip_retry_wait',
          productionState: 'retry_scheduled',
          nextClipAttemptAt: retryAt,
          twitchSegmentDurationRetryAt: retryAt
        });
        console.warn('Requeued one Twitch highlight with invalid measured duration: ' + draft.id);
        enqueueHighlightBatch(draft.id);
        continue;
      }
      if (shouldPullForwardAllowedTwitchDownloadHost(draft)) {
        const retryAt = new Date(timestamp).toISOString();
        await store.updateDraft(draft.id, {
          status: 'clip_retry_wait',
          productionState: 'retry_scheduled',
          nextClipAttemptAt: retryAt,
          twitchDownloadHostAllowlistRetryAt: retryAt
        });
        console.warn('Pulled the corrected Twitch download-host batch forward once: ' + draft.id);
        enqueueHighlightBatch(draft.id);
        continue;
      }
      if (shouldRequeueUnexpectedTwitchDownloadHost(draft)) {
        const retryAt = new Date(timestamp).toISOString();
        await store.updateDraft(draft.id, {
          status: 'clip_retry_wait',
          productionState: 'retry_scheduled',
          nextClipAttemptAt: retryAt,
          twitchDownloadHostDiagnosticRetryAt: retryAt
        });
        console.warn('Requeued one failed Twitch download-host batch for diagnosis: ' + draft.id);
        enqueueHighlightBatch(draft.id);
        continue;
      }
      if (!shouldPullForwardTwitchMetadataRetry(draft, timestamp)) continue;
      const nextClipAttemptAt = new Date(timestamp + 60 * 1000).toISOString();
      await store.updateDraft(draft.id, { nextClipAttemptAt });
      console.info('Moved Twitch metadata retry for batch ' + draft.id + ' forward to ' + nextClipAttemptAt);
    }
  } catch (error) {
    console.error('Failed to scan scheduled highlight retries:', error.message);
  } finally {
    highlightRetryScanRunning = false;
  }
}
const highlightRetryTimer = setInterval(() => { void scheduleDueHighlightRetries(); }, 30 * 1000);
highlightRetryTimer.unref();

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/healthz', async (_req, res) => {
  try {
    await store.ping();
    channelTagWorker.schedule();
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
    const [connected, canApprove, analyticsReadAccess, syncState] = await Promise.all([
      youtube.isConnected(), youtube.canApprove(), youtube.hasAnalyticsReadAccess(), store.getSeoSyncState()
    ]);
    res.json({ connected, canApprove, analyticsReadAccess,
      analyticsNeedsReconnect: syncState.youtubeSearchAnalyticsNeedsReconnect === true });
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

app.post('/api/seo/google-search/import', admin, uploadGoogleSearchCsv, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Select the Pages or Posts CSV exported from Search Console.' });
    }
    if (path.extname(req.file.originalname || '').toLowerCase() !== '.csv') {
      return res.status(400).json({ error: 'Extract the Search Console export and upload its Pages or Posts CSV file.' });
    }
    const periodStart = String(req.body?.periodStart || '');
    const periodEnd = String(req.body?.periodEnd || '');
    if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodStart > periodEnd) {
      return res.status(400).json({ error: 'Enter valid dates matching the Search Console report.' });
    }
    let snapshots;
    try {
      snapshots = parseGoogleSearchConsoleCsv(req.file.buffer.toString('utf8'));
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const result = await store.saveGoogleSearchSnapshots(snapshots, periodStart, periodEnd);
    res.set('Cache-Control', 'no-store');
    res.json({
      periodStart, periodEnd, parsedCount: snapshots.length,
      savedCount: result.savedCount, skippedCount: result.skippedCount
    });
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
      id: channel.id, etag: channel.etag, title: channel.title, description: channel.description,
      keywords: channel.keywords, defaultLanguage: channel.defaultLanguage,
      localizations: channel.localizations,
      japaneseSuggestion: suggestJapaneseChannelLocalization({ title: channel.title, description: channel.description }),
      suggestions: channelSuggestions(videos.filter((video) => video.source?.channelId === channel.id)),
      audit: [
        ...(!channel.description.trim() ? ['Channel description is empty.'] :
          channel.description.trim().length < 80 ? ['Channel description is brief; review its topic and audience.'] : []),
        ...(!channel.keywords.trim() ? ['No channel keywords are set.'] : [])
      ]
    });
  } catch (error) { next(error); }
});

app.put('/api/seo/channel/localization/ja', admin, async (req, res, next) => {
  try {
    const localization = normalizeJapaneseChannelLocalization(req.body);
    const { id, etag } = req.body || {};
    if (typeof id !== 'string' || typeof etag !== 'string') {
      return res.status(400).json({ error: 'Refresh the channel before saving its Japanese localization' });
    }
    const state = await store.getSeoSyncState();
    if (state.channelId && state.channelId !== id) {
      throw problem('Connected channel differs from the SEO catalog. Rescan before editing.', 409);
    }
    const result = await youtube.updateJapaneseChannelLocalization({ id, etag }, localization);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    if (error.status === 400 || error.status === 409) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});


app.get('/api/seo/localization/ja/autopilot', admin, async (_req, res, next) => {
  try {
    const state = await japaneseLocalizationWorker.getState();
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: state.enabled, status: state.status,
      dailyLimit: japaneseLocalizationWorker.dailyLimit,
      perRunLimit: japaneseLocalizationWorker.perRunLimit,
      updatesToday: state.updatesToday, totalUpdated: state.totalUpdated,
      lastRunStartedAt: state.lastRunStartedAt, lastRunFinishedAt: state.lastRunFinishedAt,
      lastRun: state.lastRun, lastError: state.lastError
    });
  } catch (error) { next(error); }
});

app.put('/api/seo/localization/ja/autopilot', admin, async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }
    if (req.body.enabled) {
      if (!process.env.SEO_AI_API_KEY || !process.env.SEO_AI_MODEL) {
        return res.status(503).json({ error: 'Configure SEO_AI_API_KEY and SEO_AI_MODEL before enabling Japanese autopilot' });
      }
      if (!await youtube.isConnected()) {
        return res.status(409).json({ error: 'Connect the YouTube owner account before enabling Japanese autopilot' });
      }
    }
    const state = await japaneseLocalizationWorker.getState();
    const updated = {
      ...state, enabled: req.body.enabled,
      status: req.body.enabled ? 'queued' : 'paused',
      lastError: null, retryAfter: null
    };
    await store.saveJapaneseLocalizationAutopilotState(updated);
    if (updated.enabled) japaneseLocalizationWorker.schedule(true);
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: updated.enabled, status: updated.status,
      dailyLimit: japaneseLocalizationWorker.dailyLimit,
      perRunLimit: japaneseLocalizationWorker.perRunLimit,
      updatesToday: updated.updatesToday, totalUpdated: updated.totalUpdated,
      lastRunStartedAt: updated.lastRunStartedAt, lastRunFinishedAt: updated.lastRunFinishedAt,
      lastRun: updated.lastRun, lastError: updated.lastError
    });
  } catch (error) { next(error); }
});

app.get('/api/seo/localization/ja/videos', admin, async (req, res, next) => {
  try {
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    if (!Number.isSafeInteger(offset) || offset > 100000) {
      return res.status(400).json({ error: 'Invalid video page offset' });
    }
    const page = await youtube.ownedVideosPage(offset, 10);
    const items = page.items.filter((video) => video.snippet?.channelId === page.channelId).map((video) => ({
      id: video.id, etag: video.etag || null,
      title: video.snippet?.title || '', description: video.snippet?.description || '',
      privacyStatus: video.status?.privacyStatus || 'unknown',
      defaultLanguage: video.snippet?.defaultLanguage || null,
      localization: video.localizations?.ja || null
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ offset, total: page.total, pageSize: 10, uploadsRead: true, items });
  } catch (error) { next(error); }
});

app.put('/api/seo/videos/:id/localization/ja', admin, async (req, res, next) => {
  try {
    if (!/^[A-Za-z0-9_-]{11}$/.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }
    if (typeof req.body?.etag !== 'string' || !req.body.etag) {
      return res.status(400).json({ error: 'Refresh the video before saving its Japanese localization' });
    }
    const result = await youtube.updateJapaneseVideoLocalization({
      id: req.params.id, etag: req.body.etag
    }, req.body);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.put('/api/youtube/playlists/:playlistId/localization/ja', admin, async (req, res, next) => {
  try {
    if (typeof req.body?.etag !== 'string' || !req.body.etag) {
      return res.status(400).json({ error: 'Refresh the playlist before saving its Japanese localization' });
    }
    const result = await youtube.updateJapanesePlaylistLocalization({
      id: req.params.playlistId, etag: req.body.etag
    }, req.body);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.post('/api/seo/playlist-coverage/reconcile', admin, async (_req, res, next) => {
  try {
    const report = await playlistAuto.reconcilePlaylistCoverage();
    if (report.requeuedCount) seo.schedule(true);
    res.set('Cache-Control', 'no-store');
    res.json(report);
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

app.get('/api/twitch/highlight-discovery/status', admin, (_req, res) => {
  const gameplayScreeningEnabled = process.env.ENABLE_GAMEPLAY_SCREENING === 'true';
  const gameplayVisionKeyConfigured = Boolean(process.env.VIDEO_ANALYSIS_API_KEY);
  res.json({ ...twitchHighlightDiscovery.status(), gameplayScreeningEnabled,
    gameplayVisionKeyConfigured,
    visualGameplayVerificationConfigured: gameplayScreeningEnabled && gameplayVisionKeyConfigured });
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
    market.resetBackoff();
    await japaneseLocalizationWorker.resumeAfterYouTubeReconnect();
    await seo.resumeAfterYouTubeReconnect();
    channelTagWorker.resumeAfterYouTubeReconnect();
    monetization.resumeAfterYouTubeReconnect();
    delete req.session.oauthState;
    seo.schedule(true);
    market.schedule();
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
    await store.resetSeoPlaylistResults();
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
    const draft = await store.getDraft(req.params.id);    if (!draft) return res.status(404).json({ error: 'Draft not found' });
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
    if (req.body.audioLanguage !== undefined && String(req.body.audioLanguage).trim()) {
      unlinkQuietly(req.file.path);
      return res.status(422).json({ error: 'YouTube Data API cannot set original spoken-audio language. Upload without audioLanguage, then verify or correct it in YouTube Studio.' });
    }
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
      tags, context, playlistAssignment })
      .catch((error) => console.error('Upload SEO registration failed:', error.message));
    res.status(201).json(draft);
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(error);
  }
});

app.post('/api/twitch/vod-clips', admin, async (req, res, next) => {
  try {
    const vodId = cleanText(req.body?.vodId, 40);
    if (!/^\d+$/.test(vodId)) return res.status(400).json({ error: 'vodId must be a Twitch VOD number' });
    const twitchStatus = await twitch.connectionStatus();
    if (!twitchStatus.connected) {
      return res.status(409).json({ error: twitchStatus.error || 'Connect Twitch in the Amaana dashboard first' });
    }
    const result = await twitchHighlightDiscovery.scanVod(vodId);
    if (result.status === 'visual_gameplay_screening_disabled') {
      return res.json({ accepted: false, retryScheduled: true,
        message: 'Visual gameplay screening is off. Enable ENABLE_GAMEPLAY_SCREENING and configure VIDEO_ANALYSIS_API_KEY to create gaming edits.' });
    }
    const communityClipsQueued = Number(result.communityClipsQueued) || 0;
    if (['no_gameplay_candidates', 'insufficient_gameplay_duration',
      'insufficient_quality_gameplay'].includes(result.status)) {
      const available = Math.max(0, Number(result.availableGameplaySeconds) || 0);
      const reason = result.status === 'no_gameplay_candidates'
        ? 'No Twitch clips with a game category are available for this VOD yet.'
        : result.status === 'insufficient_quality_gameplay'
          ? 'The available clips did not meet the gameplay-quality threshold for a 12-minute highlight.'
          : `Only ${Math.floor(available / 60)}m ${Math.floor(available % 60)}s of non-overlapping game-category footage is available; a 12-minute highlight needs 12m.`;
      const queuedNotice = communityClipsQueued
        ? ` Queued ${communityClipsQueued} Twitch clip${communityClipsQueued === 1 ? '' : 's'} for Gemini gameplay screening; passing clips become private YouTube drafts for your review.`
        : '';
      return res.status(communityClipsQueued ? 202 : 200).json({
        accepted: communityClipsQueued > 0,
        status: result.status,
        retryScheduled: true,
        communityClipsQueued,
        message: reason + queuedNotice + ' Amaana will rescan for more clips.'
      });
    }
    const batch = result.batch;
    res.status(202).json({
      accepted: true,
      status: result.status,
      communityClipsQueued,
      highlightVideo: batch ? { id: batch.id, status: batch.status, title: batch.title } : null,
      targetHighlightDurationSeconds: Number(batch?.targetHighlightDurationSeconds) || null,
      shortsPlanned: Array.isArray(batch?.shortCandidateIndexes) ? batch.shortCandidateIndexes.length
        : (Array.isArray(batch?.highlights) ? batch.highlights.length : 0),
      discoverySource: 'twitch_clips_api',
      message: batch
        ? 'The VOD highlight is queued for processing. Any passing clip uploads will remain private for your review.'
        : `VOD scan status: ${result.status}. Any passing clip uploads remain private for your review.`
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/exclude-test-vod', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const relatedDrafts = collectTestVodDrafts(await store.listDrafts(), draft.id);
    if (!relatedDrafts.length) {
      return res.status(409).json({ error: 'Only a test-titled Twitch highlight VOD can be excluded this way.' });
    }
    const updated = await store.excludeDrafts(
      relatedDrafts.map((item) => item.id), 'non_gameplay_test_stream', draft.id
    );
    res.json({ excludedCount: updated.length, youtubeVisibilityChanged: false });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/reconcile-upload', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const youtubeVideoId = String(req.body?.youtubeVideoId || '').trim();
    const confirmNoUpload = req.body?.confirmNoUpload === true;
    if (Boolean(youtubeVideoId) === confirmNoUpload) {
      return res.status(400).json({ error: 'Provide a private video ID or explicitly confirm that no matching upload exists' });
    }
    if (!['twitch_vod', 'twitch_highlight_batch', 'twitch_highlight_short'].includes(draft.sourceType) ||
        draft.status !== 'clip_upload_uncertain') {
      return res.status(409).json({ error: 'Only an uncertain Twitch upload can be reconciled' });
    }
    if (draft.sourceType === 'twitch_highlight_short') {
      const parent = await store.getDraft(draft.parentId);
      if (!parent || parent.sourceType !== 'twitch_highlight_batch' || !parent.youtubeVideoId) {
        return res.status(409).json({ error: 'The parent highlight must have a saved private YouTube video before reconciling its Short' });
      }
    }
    if (youtubeVideoId) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId)) {
        return res.status(400).json({ error: 'Enter the 11-character ID of the private YouTube video' });
      }
      const [channel, video] = await Promise.all([
        youtube.ownedChannel(), youtube.getVideo(youtubeVideoId)
      ]);
      if (!video || video.id !== youtubeVideoId) {
        return res.status(404).json({ error: 'YouTube video was not found on the connected channel' });
      }
      if (video.snippet?.channelId !== channel.id) {
        return res.status(403).json({ error: 'That video does not belong to the connected YouTube channel' });
      }
      if (video.status?.privacyStatus !== 'private') {
        return res.status(409).json({ error: 'Only a matching private video can be attached during reconciliation' });
      }
      if (String(video.snippet?.title || '').trim() !== String(draft.title || '').trim()) {
        return res.status(409).json({ error: 'The private video title does not match this draft; verify the ID before attaching it' });
      }
    }
    const patch = buildUploadReconciliationPatch(draft, {
      youtubeVideoId: youtubeVideoId || undefined, confirmNoUpload
    });
    const updated = await store.updateDraftIfUnchanged(draft.id, draft, patch);
    if (!updated) {
      return res.status(409).json({ error: 'Draft changed during reconciliation; refresh it and verify the upload again.' });
    }
    if (draft.sourceType === 'twitch_highlight_batch') {
      if (youtubeVideoId || confirmNoUpload) enqueueHighlightBatch(draft.id);
    } else if (draft.sourceType === 'twitch_highlight_short') {
      enqueueHighlightBatch(draft.parentId);
    } else if (confirmNoUpload) {
      enqueueClipProcessing(draft.id);
    }
    res.json({ draft: updated, youtubeVisibilityChanged: false, publicationTriggered: false });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drafts/:id/retry', admin, async (req, res, next) => {
  try {
    const draft = await store.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (['clip_upload_uncertain', 'uploading_private_to_youtube'].includes(draft.status)) {
      return res.status(409).json({ error: 'Reconcile the YouTube upload before retrying to avoid a duplicate video' });
    }
    if (isUploadRetryCoolingDown(draft)) {
      return res.status(409).json({ error: 'This retry is still inside its provider backoff window' });
    }
    if (!canRetryTwitchDraft(draft)) {
      return res.status(409).json({ error: 'Only failed Twitch clip jobs outside their retry window can be retried' });
    }
    const updated = await store.updateDraftIfUnchanged(draft.id, draft, {
      status: 'clip_queued', productionState: 'queued', productionFailures: [],
      clipAttemptCount: 0, nextClipAttemptAt: null, error: null,
      uploadRejectionStatus: null,
      retryLeaseUntil: null, retryLeaseClaimedAt: null, retryLeaseClaimToken: null
    });
    if (!updated) {
      return res.status(409).json({ error: 'Draft changed while retrying; refresh it before trying again.' });
    }
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
    if (draft.sourceType === 'twitch_vod' &&
        draft.discoverySource === 'twitch_live_capture' &&
        !hasVerifiedLiveGameplayClip(draft)) {
      return res.status(409).json({ error: 'This live clip did not pass gameplay verification and cannot be published.' });
    }
    if (draft.sourceType === 'twitch_highlight_batch' && !hasVerifiedGameplayHighlight(draft)) {
      return res.status(409).json({ error: 'This highlight has not passed gameplay verification and cannot be published. Keep it private and create a new verified edit.' });
    }
    if (draft.sourceType === 'twitch_highlight_short') {
      const parent = await store.getDraft(draft.parentId);
      if (!parent || parent.status === 'excluded_by_owner' ||
          parent.productionState === 'excluded' || parent.excludedAt ||
          !hasVerifiedGameplayHighlight(parent)) {
        return res.status(409).json({ error: 'This Short does not belong to a verified, included gameplay highlight and cannot be published. Keep it private.' });
      }
    }
    const published = await youtube.publish(draft.youtubeVideoId, req.body.publishAt || null);
    const playlistAssignment = req.body.publishAt
      ? draft.playlistAssignment
      : await autoAssignPublishedPlaylist(draft.youtubeVideoId, draft);
    if (!req.body.publishAt && playlistAssignment &&
        !['daily_limit', 'disabled', 'ineligible'].includes(playlistAssignment.state) &&
        typeof store.markSeoPlaylistResult === 'function') {
      await store.markSeoPlaylistResult(draft.youtubeVideoId, playlistAssignment);
    }
    const updated = await store.updateDraft(draft.id, {
      playlistAssignment,
      status: req.body.publishAt ? 'scheduled' : 'published',
      publicationStatus: req.body.publishAt ? 'scheduled' : 'published',
      publishedAt: req.body.publishAt ? null : new Date().toISOString(),
      publishAt: req.body.publishAt || null,
      youtubePrivacyStatus: req.body.publishAt ? 'private' : 'public',
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

initializeWithRetry(() => store.init(), {
  maxAttempts: 4,
  onRetry: (_error, attempt, delayMs) =>
    console.warn(`Database initialization retry ${attempt}/3 in ${delayMs}ms`)
}).then(async () => {
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
      channelTagWorker.schedule();
      monetization.schedule();
      market.schedule();
      void scheduleDueHighlightRetries();
      try {
        let drafts = await store.listDrafts();
        const resumableHighlightStatuses = new Set([
          'clip_queued', 'creating_twitch_clips', 'assembling_highlight_video',
          'creating_shorts', 'clip_partial', 'clip_retry_wait'
        ]);
        const resumableVodStatuses = new Set([
          'clip_queued', 'creating_twitch_clip', 'waiting_for_clip_media',
          'downloading_twitch_clip', 'formatting_vertical_short', 'clip_retry_wait'
        ]);
        for (const draft of drafts) {
          const exhaustedVod = draft.sourceType === 'twitch_vod' &&
            resumableVodStatuses.has(draft.status) &&
            Number(draft.clipAttemptCount || 0) >= twitchClipMaxAutoAttempts;
          const exhaustedHighlight = draft.sourceType === 'twitch_highlight_batch' &&
            resumableHighlightStatuses.has(draft.status) &&
            Number(draft.clipAttemptCount || 0) >= highlightMaxAutoAttempts;
          if (exhaustedVod || exhaustedHighlight) {
            await store.updateDraft(draft.id, {
              status: 'clip_failed', productionState: 'manual_review',
              error: 'Automatic Twitch processing attempt limit reached; owner review is required.',
              nextClipAttemptAt: null, retryLeaseUntil: null,
              retryLeaseClaimedAt: null, retryLeaseClaimToken: null
            });
            console.warn('Marked exhausted Twitch draft for owner review: ' + draft.id);
          }
        }
        drafts = await recoverInterruptedYouTubeUploads(drafts,
          (id, patch) => store.updateDraft(id, patch),
          (error, draft) => console.error('Could not persist interrupted upload recovery for ' +
            draft.id + ': ' + error.message));
        twitchHighlightDiscovery.start();
        const resumable = new Set([
          'clip_queued',
          'creating_twitch_clip',
          'waiting_for_clip_media',
          'downloading_twitch_clip',
          'formatting_vertical_short',
          'clip_retry_wait'
        ]);
        drafts.filter((draft) => {
          const retryAt = Date.parse(draft.nextClipAttemptAt || '');
          const leaseUntil = Date.parse(draft.retryLeaseUntil || '');
          const leaseValue = draft.retryLeaseUntil;
          return draft.sourceType === 'twitch_vod' && resumable.has(draft.status) &&
            Number(draft.clipAttemptCount || 0) < twitchClipMaxAutoAttempts &&
            !(leaseValue != null && leaseValue !== '' && Number.isFinite(leaseUntil) && leaseUntil > Date.now()) &&
            (draft.status !== 'clip_retry_wait' ||
              Number.isFinite(retryAt) && retryAt <= Date.now());
        }).forEach((draft) => enqueueClipProcessing(draft.id));
        drafts.filter((draft) => draft.sourceType === 'twitch_highlight_batch' &&
          ['clip_queued', 'creating_twitch_clips', 'assembling_highlight_video', 'creating_shorts'].includes(draft.status) &&
          Number(draft.clipAttemptCount || 0) < highlightMaxAutoAttempts &&
          !(Number.isFinite(Date.parse(draft.retryLeaseUntil || '')) &&
            Date.parse(draft.retryLeaseUntil) > Date.now()))
          .forEach((draft) => enqueueHighlightBatch(draft.id));
      } catch (error) {
        console.error('Failed to resume Twitch clip jobs:', error.message);
        twitchHighlightDiscovery.start();
      }
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });

