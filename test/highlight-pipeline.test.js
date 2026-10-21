'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBatchQueue, createHighlightProcessor, findDueHighlightRetries,
  findHighlightBatchByVodId, isTransientError, shouldPullForwardTwitchMetadataRetry,
  shouldRequeueUnexpectedTwitchDownloadHost, shouldPullForwardAllowedTwitchDownloadHost,
  shouldRequeueTwitchSegmentDurationFailure, waitForVerifiedClipMetadata } = require('../src/highlight-pipeline');
const { buildHighlightTimeline, buildHighlightDescription } = require('../src/highlight-metadata');
const { downloadClip } = require('../src/twitch');
const { computeRetryDelayMs } = require('../src/draft-recovery');

test('one-time diagnostic retry is limited to failed Twitch download-host batches', () => {
  const failed = {
    sourceType: 'twitch_highlight_batch',
    status: 'clip_failed',
    error: 'Twitch returned an unexpected clip download host: media.example'
  };
  assert.equal(shouldRequeueUnexpectedTwitchDownloadHost(failed), true);
  assert.equal(shouldRequeueUnexpectedTwitchDownloadHost({
    ...failed, twitchDownloadHostDiagnosticRetryAt: new Date().toISOString()
  }), false);
  assert.equal(shouldRequeueUnexpectedTwitchDownloadHost({ ...failed, status: 'clip_partial' }), false);
  assert.equal(shouldRequeueUnexpectedTwitchDownloadHost({
    ...failed, sourceType: 'twitch_vod'
  }), false);
  assert.equal(shouldRequeueUnexpectedTwitchDownloadHost({
    ...failed, error: 'Twitch clip media was unavailable'
  }), false);
});

test('accepts only Amaana\'s observed Twitch CloudFront download host', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-twitch-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'clip.mp4');
  const originalFetch = global.fetch;
  const requestedHosts = [];
  global.fetch = async (input) => {
    requestedHosts.push(new URL(input).hostname);
    return new Response(Buffer.from('fixture media'));
  };
  try {
    await downloadClip(
      'https://d1ndex63qxojbr.cloudfront.net/clip.mp4?token=private',
      destination
    );
    assert.deepEqual(requestedHosts, ['d1ndex63qxojbr.cloudfront.net']);
    assert.equal(await fs.readFile(destination, 'utf8'), 'fixture media');
  } finally {
    global.fetch = originalFetch;
  }
});

test('unknown Twitch download hosts remain blocked before network access', async () => {
  const originalFetch = global.fetch;
  let requested = false;
  global.fetch = async () => { requested = true; throw new Error('Unexpected fetch'); };
  try {
    await assert.rejects(
      downloadClip('https://other-distribution.cloudfront.net/clip.mp4?token=private', '/tmp/unused-amaana-clip.mp4'),
      (error) => error.message === 'Twitch returned an unexpected clip download host: other-distribution.cloudfront.net' &&
        error.status === 502 && !error.message.includes('private')
    );
    assert.equal(requested, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pulls the corrected Twitch host forward for one Amaana batch only once', () => {
  const failed = {
    sourceType: 'twitch_highlight_batch',
    status: 'clip_failed',
    error: 'Twitch returned an unexpected clip download host: d1ndex63qxojbr.cloudfront.net'
  };
  assert.equal(shouldPullForwardAllowedTwitchDownloadHost(failed), true);
  assert.equal(shouldPullForwardAllowedTwitchDownloadHost({
    ...failed, status: 'clip_retry_wait', nextClipAttemptAt: new Date(Date.now() + 60_000).toISOString()
  }), true);
  assert.equal(shouldPullForwardAllowedTwitchDownloadHost({
    ...failed, twitchDownloadHostAllowlistRetryAt: new Date().toISOString()
  }), false);
  assert.equal(shouldPullForwardAllowedTwitchDownloadHost({
    ...failed, error: 'Twitch returned an unexpected clip download host: other.example'
  }), false);
  assert.equal(shouldPullForwardAllowedTwitchDownloadHost({
    ...failed, sourceType: 'twitch_vod'
  }), false);
});

test('duration recovery is limited to one failed Amaana highlight batch', () => {
  const failed = {
    sourceType: 'twitch_highlight_batch',
    status: 'clip_failed',
    error: 'Every highlight segment needs a measured duration between 5 and 60 seconds: segment 1 measured 60.020 seconds'
  };
  assert.equal(shouldRequeueTwitchSegmentDurationFailure(failed), true);
  assert.equal(shouldRequeueTwitchSegmentDurationFailure({
    ...failed, status: 'clip_retry_wait'
  }), true);
  assert.equal(shouldRequeueTwitchSegmentDurationFailure({
    ...failed, twitchSegmentDurationRetryAt: new Date().toISOString()
  }), false);
  assert.equal(shouldRequeueTwitchSegmentDurationFailure({
    ...failed, error: 'FFmpeg failed'
  }), false);
  assert.equal(shouldRequeueTwitchSegmentDurationFailure({
    ...failed, sourceType: 'twitch_vod'
  }), false);
});

const moments = [
  { startSeconds: 30, endSeconds: 60, duration: 30, title: 'Moment one', reason: 'A clutch play', score: 95 },
  { startSeconds: 90, endSeconds: 120, duration: 30, title: 'Moment two', reason: 'A close finish', score: 88 },
  { startSeconds: 150, endSeconds: 180, duration: 30, title: 'Moment three', reason: 'A funny reaction', score: 82 }
];

async function harness(t, options = {}) {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-highlight-'));
  t.after(() => fs.rm(uploadDir, { recursive: true, force: true }));
  const batch = {
    id: 'batch-1', sourceType: 'twitch_highlight_batch', vodId: '1234567890',
    highlights: structuredClone(moments), streamTitle: 'Saevond ranked session',
    vodDurationSeconds: 3600, autoPublishEligible: true, publicationStatus: 'pending',
    pipelineVersion: 2, thumbnailStatus: 'pending', status: 'clip_queued'
  };
  const drafts = new Map([[batch.id, batch]]);
  const counters = {
    clipCreates: 0, clipMetadataChecks: 0, readyLogs: [], uploads: [], thumbnailSets: 0, thumbnailCreates: 0,
    thumbnailSource: null, thumbnailOptions: null,
    shortRenders: 0, gameplayVerifications: 0, assemblyTarget: null, validationTarget: null,
    seo: [], playlists: [], visibilityMutations: 0,
    publicationChecks: [], publications: [], errors: []
  };
  const processingChecks = new Map();
  let listFailureUsed = false;
  let getDraftFailureUsed = false;
  let clipFailureUsed = false;
  let thumbnailUploadFailureUsed = false;
  let thumbnailCreateFailureUsed = false;
  let shortFailureUsed = false;
  let seoFailureUsed = false;
  let idCounter = 0;
  let leaseCounter = 0;
  let clipSaveFailureUsed = false;

  const copy = (value) => value && structuredClone(value);
  const store = {
    async getDraft(id) {
      if (options.failGetDraftOnce && !getDraftFailureUsed) {
        getDraftFailureUsed = true;
        throw Object.assign(new Error('database connection reset before draft read'), { code: 'ECONNRESET' });
      }
      return copy(drafts.get(id));
    },
    async listDrafts() {
      if (options.failListDraftsOnce && !listFailureUsed) {
        listFailureUsed = true;
        throw Object.assign(new Error('database connection reset'), { code: 'ECONNRESET' });
      }
      return [...drafts.values()].map(copy);
    },
    async addDraft(draft) {
      if (drafts.has(draft.id)) throw new Error('duplicate draft id');
      drafts.set(draft.id, copy(draft));
      return copy(draft);
    },
    async updateDraft(id, patch) {
      const current = drafts.get(id);
      if (!current || current.status === 'excluded_by_owner' ||
          current.productionState === 'excluded' || current.excludedAt) return null;
      const next = { ...current, ...copy(patch), updatedAt: new Date().toISOString() };
      drafts.set(id, next);
      return copy(next);
    },
    async updateDraftWithRetryLease(id, token, patch) {
      const current = drafts.get(id);
      const until = Date.parse(current?.retryLeaseUntil || '');
      if (!current || current.retryLeaseClaimToken !== token || !Number.isFinite(until) ||
          until <= Date.now() || current.status === 'excluded_by_owner' ||
          current.productionState === 'excluded' || current.excludedAt) return null;
      if (options.failClipSaveOnce && patch.pendingTwitchClipIntentIndex === null &&
          Array.isArray(patch.twitchClips) && !clipSaveFailureUsed) {
        clipSaveFailureUsed = true;
        throw Object.assign(new Error('database connection reset after Twitch accepted clip'), { code: 'ECONNRESET' });
      }
      const next = { ...current, ...copy(patch), updatedAt: new Date().toISOString() };
      drafts.set(id, next);
      return copy(next);
    },
    async addHighlightShortDraft(parentId, token, draft) {
      const parent = drafts.get(parentId);
      const until = Date.parse(parent?.retryLeaseUntil || '');
      if (!parent || parent.status !== 'creating_shorts' || !parent.youtubeVideoId ||
          parent.retryLeaseClaimToken !== token || !Number.isFinite(until) || until <= Date.now() ||
          parent.productionState === 'excluded' || parent.excludedAt) return null;
      if (drafts.has(draft.id)) throw new Error('duplicate draft id');
      drafts.set(draft.id, copy(draft));
      return copy(draft);
    },
    async reserveHighlightShortUpload(parentId, token, shortId, patch) {
      const parent = drafts.get(parentId);
      const child = drafts.get(shortId);
      const until = Date.parse(parent?.retryLeaseUntil || '');
      if (!parent || parent.status !== 'creating_shorts' || !parent.youtubeVideoId ||
          parent.retryLeaseClaimToken !== token || !Number.isFinite(until) || until <= Date.now() ||
          parent.productionState === 'excluded' || parent.excludedAt || !child ||
          child.status === 'excluded_by_owner' || child.productionState === 'excluded' || child.excludedAt ||
          child.parentId !== parentId) return null;
      const updated = { ...child, ...copy(patch), updatedAt: new Date().toISOString() };
      drafts.set(shortId, updated);
      return copy(updated);
    },
    async claimHighlightRetryParent(id, claimOptions = {}) {
      const current = drafts.get(id);
      const now = Number.isFinite(Number(claimOptions.now)) ? Number(claimOptions.now) : Date.now();
      const leaseUntil = Date.parse(current?.retryLeaseUntil || '');
      if (!current || current.status === 'excluded_by_owner' ||
          current.productionState === 'excluded' || current.excludedAt ||
          current.status === 'completed' ||
          current.status === 'awaiting_owner_approval' && current.productionState === 'ready' ||
          current.retryLeaseClaimToken && Number.isFinite(leaseUntil) && leaseUntil > now) return null;
      const token = '00000000-0000-4000-8000-' + String(++leaseCounter).padStart(12, '0');
      const claimed = { ...current, retryLeaseClaimToken: token,
        retryLeaseClaimedAt: new Date(now).toISOString(),
        retryLeaseUntil: new Date(now + (Number(claimOptions.leaseMs) || 900000)).toISOString() };
      drafts.set(id, claimed);
      return copy(claimed);
    },
    async extendHighlightRetryLease(id, token, leaseMs = 900000) {
      const current = drafts.get(id);
      if (!current || current.retryLeaseClaimToken !== token ||
          current.status === 'excluded_by_owner' || current.productionState === 'excluded') return null;
      const next = { ...current, retryLeaseUntil: new Date(Date.now() + leaseMs).toISOString() };
      drafts.set(id, next);
      return copy(next);
    },
    async releaseHighlightRetryLease(id, token) {
      const current = drafts.get(id);
      if (!current || current.retryLeaseClaimToken !== token) return null;
      const next = { ...current, retryLeaseUntil: null, retryLeaseClaimedAt: null,
        retryLeaseClaimToken: null };
      drafts.set(id, next);
      return copy(next);
    }
  };

  const twitch = {
    async createClipFromVod({ vodOffset }) {
      counters.clipCreates += 1;
      if (options.failClipCreateAlways || options.failClipCreateOnce && !clipFailureUsed) {
        clipFailureUsed = true;
        throw Object.assign(new Error('Twitch rate limit'), { status: 429 });
      }
      return { id: 'clip-' + vodOffset, broadcasterId: 'broadcaster', editorId: 'editor' };
    },
    async waitForClipDownload({ clipId }) {
      return { landscape_download_url: 'fixture://' + clipId };
    },
    async getClip(clipId) {
      counters.clipMetadataChecks += 1;
      if (options.metadataPendingAlways ||
          counters.clipMetadataChecks <= (Number(options.metadataPendingAttempts) || 0)) {
        const error = new Error('Twitch clip metadata is not linked to the requested VOD yet');
        error.status = 425;
        throw error;
      }
      const end = Number(String(clipId).slice('clip-'.length));
      const duration = Number(options.clipDuration) || 30;
      return { id: clipId, video_id: options.wrongVodId ? '9876543210' : '1234567890',
        vod_offset: end - duration + (options.timestampDrift || 0), duration };
    },
    async downloadClip(_url, destination) { await fs.writeFile(destination, 'fixture media'); }
  };

  const video = {
    thumbnailHeadline(title) { return title.slice(0, 35); },
    async createThumbnail(source, destination, thumbnailOptions) {
      counters.thumbnailCreates += 1;
      counters.thumbnailSource = source;
      counters.thumbnailOptions = thumbnailOptions;
      if (options.failThumbnailCreateOnce && !thumbnailCreateFailureUsed) {
        thumbnailCreateFailureUsed = true;
        throw new Error('FFmpeg frame extraction failed');
      }
      await fs.writeFile(destination, 'fixture thumbnail');
    },
    async assembleHighlights(sources, destination, _segmentDir, expectedDurations, targetDurationSeconds) {
      counters.assemblyTarget = targetDurationSeconds;
      await fs.writeFile(destination, 'fixture montage');
      return options.invalidDuration ? sources.map(() => 0) : expectedDurations.map(Number);
    },
    async verifyGameplay() {
      counters.gameplayVerifications += 1;
      if (options.gameplayVerificationResult) return options.gameplayVerificationResult;
      if (options.failGameplayVerification) {
        return { verified: false, activeGameplayFrames: 1, totalFrames: 5, confidence: 0.35, model: 'test' };
      }
      return { verified: true, activeGameplayFrames: 5, totalFrames: 5, confidence: 0.98,
        gameName: 'Fixture game', model: 'test' };
    },
    async validateHighlight(_filePath, expectedDuration, options = {}) {
      counters.validationTarget = { expectedDuration, exactDuration: options.exactDuration };

      if (options.failHighlightValidation) throw new Error('Landscape validation failed');
    },
    async validateShort() {
      if (options.failShortValidation) throw new Error('Short validation failed');
    },
    async shortFromHighlight(_source, _offset, _length, destination) {
      counters.shortRenders += 1;
      await fs.writeFile(destination, 'fixture short');
    }
  };

  const youtubeVideos = new Map();
  let publishFailureUsed = false;
  const youtube = {
    async uploadPrivate(request) {
      const isShort = request.tags.includes('Shorts');
      const call = { kind: isShort ? 'short' : 'highlight', title: request.title,
        privacyStatus: 'private', succeeded: false };
      counters.uploads.push(call);
      if (isShort && options.failShort403 && !shortFailureUsed) {
        shortFailureUsed = true;
        throw Object.assign(new Error('YouTube upload forbidden'), { status: 403 });
      }
      if (isShort && request.title.startsWith(options.failShortTitle || '\u0000') && !shortFailureUsed) {
        shortFailureUsed = true;
        throw Object.assign(new Error('YouTube request rate limited'), { status: 429 });
      }
      if (!isShort && options.failParentUpload403) {
        throw Object.assign(new Error('YouTube upload forbidden'), { status: 403 });
      }
      if (!isShort && options.failParentUpload429) {
        throw Object.assign(new Error('YouTube upload rate limited'), { status: 429 });
      }
      if (!isShort && options.failParentUploadTimeout) {
        throw Object.assign(new Error('YouTube upload response was lost'), { code: 'ECONNRESET' });
      }
      call.succeeded = true;
      let id = isShort ? 'yt-short-' + request.title.split(' | ')[0].toLowerCase().replaceAll(' ', '-') : 'yt-parent';
      if (isShort && youtubeVideos.has(id)) {
        id += '-' + counters.uploads.filter((upload) => upload.kind === 'short').length;
      }
      call.id = id;
      youtubeVideos.set(id, 'private');
      return { id };
    },
    async getVideo(videoId) {
      counters.publicationChecks.push(videoId);
      const checkNumber = (processingChecks.get(videoId) || 0) + 1;
      processingChecks.set(videoId, checkNumber);
      const privacyStatus = options.unlistedVideoId === videoId ? 'unlisted'
        : youtubeVideos.get(videoId) || options.initialPrivacyStatus || 'private';
      const sequence = options.processingStatuses?.[videoId];
      const processingStatus = Array.isArray(sequence)
        ? sequence[Math.min(checkNumber - 1, sequence.length - 1)]
        : options.unprocessedVideoId === videoId ? 'processing'
        : options.failedProcessingVideoId === videoId ? 'failed' : 'succeeded';
      const uploadSequence = options.uploadStatuses?.[videoId];
      const uploadStatus = Array.isArray(uploadSequence)
        ? uploadSequence[Math.min(checkNumber - 1, uploadSequence.length - 1)]
        : options.failedUploadVideoId === videoId ? 'failed'
        : options.unprocessedUploadVideoId === videoId ? 'uploaded' : 'processed';
      const liveBroadcastContent = options.liveBroadcastContent?.[videoId] ?? 'none';
      return { id: videoId, snippet: { liveBroadcastContent }, status: { privacyStatus, uploadStatus },
        processingDetails: { processingStatus } };
    },
    async publish(videoId) {
      counters.publications.push(videoId);
      if (options.failPublishOnce && counters.publications.length === 2 && !publishFailureUsed) {
        publishFailureUsed = true;
        throw Object.assign(new Error('YouTube publication rate limited'), { status: 429 });
      }
      if (options.failPublishPermanently) {
        throw Object.assign(new Error('YouTube publication forbidden'), { status: 403 });
      }
      youtubeVideos.set(videoId, options.publishAsUnlisted ? 'unlisted' : 'public');
      if (youtubeVideos.get(videoId) === 'public') counters.visibilityMutations += 1;
      return { id: videoId, status: { privacyStatus: youtubeVideos.get(videoId) } };
    },
    async setThumbnail(_videoId, _thumbnailPath) {
      counters.thumbnailSets += 1;
      if (options.failThumbnailUploadOnce && !thumbnailUploadFailureUsed) {
        thumbnailUploadFailureUsed = true;
        throw Object.assign(new Error('Thumbnail API rate limited'), { status: 429 });
      }
    },
    async setVisibility() { counters.visibilityMutations += 1; }
  };

  const seo = {
    async registerUpload(videoId, payload) {
      counters.seo.push({ videoId, title: payload.title });
      if (payload.title.startsWith(options.failSeoTitle || '\u0000') && !seoFailureUsed) {
        seoFailureUsed = true;
        throw Object.assign(new Error('SEO queue temporarily unavailable'), { status: 503 });
      }
    }
  };
  const autoAssignPlaylist = async (metadata) => {
    counters.playlists.push(metadata.privacyStatus);
    return { state: 'assigned' };
  };
  const cleanText = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const dependencies = {
    uploadDir, store, twitch, video, youtube, seo, autoAssignPlaylist,
    buildHighlightTimeline, buildHighlightDescription, cleanText,
    now: options.now,
    autoPublish: options.autoPublish !== false,
    maxAutoAttempts: options.maxAutoAttempts,
    sleep: options.sleep || (async () => {}),
    clipMetadataPollIntervalMs: options.clipMetadataPollIntervalMs || 5000,
    clipMetadataMaxAttempts: options.clipMetadataMaxAttempts,
    idFactory: () => 'short-draft-' + (++idCounter),
    logError: (_id, error) => counters.errors.push(error.message),
    logSuccess: (batchId, shortCount) => counters.readyLogs.push({ batchId, shortCount })
  };
  const processor = createHighlightProcessor(dependencies);
  return { batch, drafts, store, counters, processor,
    createProcessor: () => createHighlightProcessor(dependencies) };
}

test('legacy Twitch-discovered batches without a target duration cannot create uploads', async (t) => {
  const h = await harness(t);
  h.batch.discoverySource = 'twitch_clips_api';
  delete h.batch.targetHighlightDurationSeconds;
  await h.processor(h.batch.id);

  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.match(h.drafts.get(h.batch.id).error, /no measured target duration/);
  assert.equal(h.counters.uploads.length, 0);
  assert.equal(h.counters.publications.length, 0);
});

test('owner exclusion during upload reservation prevents a private YouTube upload', async (t) => {
  const h = await harness(t);
  const updateClaimed = h.store.updateDraftWithRetryLease.bind(h.store);
  h.store.updateDraftWithRetryLease = async (id, token, patch) => {
    if (patch.status === 'uploading_private_to_youtube') {
      const current = h.drafts.get(id);
      h.drafts.set(id, { ...current, status: 'excluded_by_owner',
        productionState: 'excluded', publicationStatus: 'excluded', excludedAt: new Date().toISOString(),
        retryLeaseUntil: null, retryLeaseClaimedAt: null, retryLeaseClaimToken: null });
      return null;
    }
    return updateClaimed(id, token, patch);
  };

  await h.processor(h.batch.id);

  assert.equal(h.drafts.get(h.batch.id).status, 'excluded_by_owner');
  assert.equal(h.counters.uploads.length, 0);
  assert.equal(h.counters.publications.length, 0);
});

test('a transient initial read releases a supplied durable retry lease after backoff is saved', async (t) => {
  const h = await harness(t, { failGetDraftOnce: true });
  const token = '00000000-0000-4000-8000-999999999999';
  h.drafts.set(h.batch.id, { ...h.batch,
    status: 'clip_retry_wait', nextClipAttemptAt: new Date(Date.now() - 1000).toISOString(),
    retryLeaseClaimToken: token, retryLeaseClaimedAt: new Date().toISOString(),
    retryLeaseUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  });
  await h.processor(h.batch.id, { retryLeaseClaimToken: token });
  const parent = h.drafts.get(h.batch.id);
  assert.equal(parent.status, 'clip_retry_wait');
  assert.ok(Date.parse(parent.nextClipAttemptAt) > Date.now());
  assert.equal(parent.retryLeaseClaimToken, null);
  assert.equal(h.counters.clipCreates, 0);
});

test('ambiguous Twitch clip creation is held for review instead of repeated', async (t) => {
  const h = await harness(t, { failClipSaveOnce: true });
  await h.processor(h.batch.id);
  const parent = h.drafts.get(h.batch.id);
  assert.equal(h.counters.clipCreates, 1);
  assert.equal(parent.status, 'clip_failed');
  assert.equal(parent.productionState, 'manual_review');
  assert.equal(parent.pendingTwitchClipIntentIndex, 0);
  assert.match(parent.error, /may have succeeded/);
  assert.equal(h.counters.uploads.length, 0);
});

test('12-minute batches assemble exactly 720 seconds across verified 60-second sources', async (t) => {
  const h = await harness(t, { autoPublish: false, clipDuration: 60 });
  h.batch.highlights = Array.from({ length: 12 }, (_value, index) => ({
    startSeconds: index * 120, endSeconds: index * 120 + 60, duration: 60,
    title: 'Gameplay moment ' + (index + 1), reason: 'Verified gameplay exchange', score: 95 - index
  }));
  h.batch.targetHighlightDurationSeconds = 12 * 60;
  h.batch.shortCandidateIndexes = [0, 11];
  h.drafts.set(h.batch.id, h.batch);
  await h.processor(h.batch.id);

  const parent = h.drafts.get(h.batch.id);
  const shorts = [...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short');
  assert.equal(h.counters.assemblyTarget, 720);
  assert.deepEqual(h.counters.validationTarget, { expectedDuration: 720, exactDuration: true });
  assert.equal(parent.duration, 720);
  assert.deepEqual(shorts.map((draft) => draft.highlightIndex), [0, 11]);
  assert.equal(h.counters.gameplayVerifications, 12);
  assert.equal(parent.status, 'awaiting_owner_approval');
  assert.equal(h.counters.publications.length, 0);
});

test('visual gameplay verification rejects facecam or non-gameplay clips before any YouTube upload', async (t) => {
  const h = await harness(t, { failGameplayVerification: true });
  await h.processor(h.batch.id);

  assert.equal(h.counters.gameplayVerifications, 1);
  assert.equal(h.counters.uploads.length, 0);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.match(h.drafts.get(h.batch.id).error, /only 1 of 5 sampled frames clearly showed active gameplay/);
});

test('complete production validates media and timestamps, then publishes all outputs after SEO and thumbnail checks', async (t) => {
  const h = await harness(t);
  await h.processor(h.batch.id);
  const parent = h.drafts.get(h.batch.id);
  const shorts = [...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short');
  assert.equal(parent.status, 'completed');
  assert.equal(parent.productionState, 'published');
  assert.equal(parent.publicationStatus, 'published');
  assert.equal(parent.mediaValidation, 'passed');
  assert.equal(parent.thumbnailStatus, 'applied');
  assert.equal(path.basename(h.counters.thumbnailSource), 'source-0.mp4');
  assert.equal(h.counters.thumbnailOptions.timestampSeconds, 15);
  assert.equal(parent.seoRegistrationStatus, 'registered');
  assert.equal(shorts.length, 3);
  assert.ok(shorts.every((draft) => draft.status === 'published' &&
    draft.productionState === 'published' && draft.seoRegistrationStatus === 'registered' &&
    draft.publicationStatus === 'published' && draft.mediaValidation === 'passed'));
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 4);
  assert.ok(h.counters.uploads.every((upload) => upload.privacyStatus === 'private'));
  assert.ok(h.counters.playlists.every((visibility) => visibility === 'private'));
  assert.equal(h.counters.seo.length, 4);
  assert.equal(h.counters.publications.length, 4);
  assert.equal(h.counters.visibilityMutations, 4);
  assert.equal(h.counters.publicationChecks.length, 8);
});

test('new Twitch clip metadata is polled until the generated clip is linked to its VOD', async (t) => {
  const h = await harness(t, { metadataPendingAttempts: 4, clipMetadataMaxAttempts: 5 });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.counters.clipMetadataChecks, 7);
  assert.equal(h.counters.clipCreates, 3);
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 4);
});

test('discovered batches verify accepted VOD requests when Twitch link metadata remains blank', async (t) => {
  const h = await harness(t, { metadataPendingAlways: true, autoPublish: false });
  const batch = { ...h.batch, discoverySource: 'twitch_clips_api', targetHighlightDurationSeconds: 90 };
  h.drafts.set(batch.id, batch);

  await h.processor(batch.id);

  const ready = h.drafts.get(batch.id);
  const shorts = [...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short');
  assert.equal(ready.status, 'awaiting_owner_approval');
  assert.equal(ready.productionState, 'ready');
  assert.equal(ready.twitchClips.length, 3);
  assert.ok(ready.twitchClips.every((clip) =>
    clip.requestedVodId === batch.vodId &&
    clip.timestampVerification.verified === true &&
    clip.timestampVerification.verificationMethod === 'twitch_vod_clip_request'));
  assert.equal(shorts.length, 3);
  assert.ok(shorts.every((draft) => draft.status === 'awaiting_owner_approval'));
  assert.equal(h.counters.clipMetadataChecks, 3);
  assert.equal(h.counters.clipCreates, 3);
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 4);
  assert.ok(h.counters.uploads.every((upload) => upload.privacyStatus === 'private'));
  assert.equal(h.counters.publications.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
  assert.deepEqual(h.counters.readyLogs, [{ batchId: batch.id, shortCount: 3 }]);
});

test('live-captured batches reuse screened clips and leave YouTube uploads private for owner review', async (t) => {
  const h = await harness(t, { autoPublish: false });
  const batch = {
    ...h.batch,
    discoverySource: 'twitch_live_capture',
    streamId: '987654',
    streamBatchIndex: 1,
    targetHighlightDurationSeconds: 90,
    shortCandidateIndexes: [],
    twitchClips: moments.map((moment) => ({
      id: 'clip-' + moment.endSeconds,
      broadcasterId: 'broadcaster',
      editorId: 'editor',
      requestedVodId: h.batch.vodId,
      requestedVodOffset: moment.endSeconds,
      requestedDuration: moment.duration,
      requestProofVersion: 1,
      liveCapture: true
    }))
  };
  h.drafts.set(batch.id, batch);

  await h.processor(batch.id);

  const ready = h.drafts.get(batch.id);
  const shorts = [...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short');
  assert.equal(ready.status, 'awaiting_owner_approval');
  assert.equal(ready.productionState, 'ready');
  assert.equal(ready.twitchClips.length, 3);
  assert.ok(ready.twitchClips.every((clip) => clip.timestampVerification.verified === true));
  assert.equal(shorts.length, 0);
  assert.equal(h.counters.clipCreates, 0);
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 1);
  assert.ok(h.counters.uploads.every((upload) => upload.privacyStatus === 'private'));
  assert.equal(h.counters.publications.length, 0);
});

test('bounded metadata polling schedules retry and reuses an existing Twitch clip', async (t) => {
  const h = await harness(t, { metadataPendingAlways: true, clipMetadataMaxAttempts: 2 });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).twitchClips.length, 1);
  assert.equal(h.counters.clipCreates, 1);
  assert.ok(Date.parse(h.drafts.get(h.batch.id).nextClipAttemptAt) - Date.now() <= 2 * 60 * 1000 + 1000);
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 0);

  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).twitchClips.length, 1);
  assert.equal(h.counters.clipCreates, 1);
  assert.equal(h.counters.clipMetadataChecks, 4);
});

test('repeated moment labels produce unique titles and clip-specific descriptions within a batch', async (t) => {
  const h = await harness(t);
  const repeated = moments.map((moment) => ({ ...moment, title: 'Same clutch moment', reason: 'A clutch play' }));
  h.batch.highlights = repeated;
  await h.store.updateDraft(h.batch.id, { highlights: repeated });
  await h.processor(h.batch.id);
  const shorts = [...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short');
  assert.equal(shorts.length, 3);
  assert.equal(new Set(shorts.map((draft) => draft.title)).size, 3);
  assert.equal(new Set(shorts.map((draft) => draft.description)).size, 3);
  assert.ok(shorts[1].title.includes('1:30'));
  assert.ok(shorts[0].description.startsWith('Same clutch moment (0:30)'));
  assert.ok(shorts[1].description.startsWith('Same clutch moment (1:30)'));
  assert.ok(h.drafts.get(h.batch.id).title.includes('Highlights: Saevond ranked session — Same clutch moment'));
});

test('a definite Short 429 schedules a deterministic safe retry without duplicate uploads', async (t) => {
  let clock = Date.now();
  const h = await harness(t, { failShortTitle: 'Moment two', now: () => clock });
  await h.processor(h.batch.id);
  const parent = h.drafts.get(h.batch.id);
  assert.equal(parent.status, 'clip_retry_wait');
  assert.ok(Date.parse(parent.nextClipAttemptAt) > clock);
  assert.match(parent.error, /Short 2/);
  assert.equal([...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short').length, 3,
    'later Shorts in the batch continue after one definite rejection');
  const retryableShort = [...h.drafts.values()].find((draft) =>
    draft.sourceType === 'twitch_highlight_short' && draft.highlightIndex === 1);
  assert.equal(retryableShort.uploadRejectionStatus, 429);
  const expectedChildDelay = computeRetryDelayMs({
    attempt: 1, providerRetryAfterMs: 0, minimumDelayMs: 1000,
    baseDelayMs: 60 * 1000, maxDelayMs: 30 * 60 * 1000, seed: retryableShort.id
  });
  assert.equal(Date.parse(retryableShort.nextClipAttemptAt), clock + expectedChildDelay);
  assert.deepEqual(findDueHighlightRetries([parent], clock), [],
    'the parent selector does not schedule before the persisted backoff');
  clock = Math.max(Date.parse(retryableShort.nextClipAttemptAt), Date.parse(parent.nextClipAttemptAt));
  assert.deepEqual(findDueHighlightRetries([parent], clock).map((draft) => draft.id), [parent.id]);
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'published');
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'highlight' && upload.succeeded).length, 1);
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'short' && upload.succeeded).length, 3);
  assert.equal(h.counters.clipCreates, 3);
  assert.equal(h.counters.publications.length, 4);
});

test('thumbnail generation and upload failures block review-ready status and recover on retry', async (t) => {
  const h = await harness(t, { failThumbnailCreateOnce: true, failThumbnailUploadOnce: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_partial');
  assert.notEqual(h.drafts.get(h.batch.id).thumbnailStatus, 'applied');
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.drafts.get(h.batch.id).thumbnailStatus, 'applied');
  assert.equal(h.counters.publications.length, 4);
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'highlight' && upload.succeeded).length, 1);
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'short' && upload.succeeded).length, 3);
});

test('SEO registration failures keep affected output partial and retry only missing SEO work', async (t) => {
  const h = await harness(t, { failSeoTitle: 'Moment one' });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  const first = [...h.drafts.values()].find((draft) => draft.highlightIndex === 0);
  assert.equal(first.seoRegistrationStatus, 'failed');
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).productionState, 'published');
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'highlight' && upload.succeeded).length, 1);
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'short' && upload.succeeded).length, 3);
});

test('a transient database error after parent persistence schedules recovery without duplicating the upload', async (t) => {
  const h = await harness(t, { failListDraftsOnce: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).youtubeVideoId, 'yt-parent');
  const restartedProcessor = h.createProcessor();
  await restartedProcessor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).productionState, 'published');
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'highlight' && upload.succeeded).length, 1);
  assert.equal(h.counters.clipCreates, 3);
  assert.equal(h.counters.publications.length, 4);
});

test('a restarted worker resumes a persisted creating-shorts batch without uploading the parent again', async (t) => {
  const h = await harness(t);
  const parent = { ...h.batch, status: 'creating_shorts', productionState: 'processing',
    twitchClips: moments.map((moment) => ({ id: 'clip-' + moment.endSeconds,
      broadcasterId: 'broadcaster', editorId: 'editor' })),
    youtubeVideoId: 'yt-parent', thumbnailStatus: 'applied', seoRegistrationStatus: 'registered' };
  h.drafts.set(h.batch.id, parent);
  h.counters.uploads.push({ kind: 'highlight', title: 'Saevond ranked session | Best moments',
    privacyStatus: 'private', succeeded: true });
  const restartedProcessor = h.createProcessor();
  await restartedProcessor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'highlight' && upload.succeeded).length, 1);
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'short' && upload.succeeded).length, 3);
  assert.equal(h.counters.clipCreates, 0);
  assert.equal(h.counters.publications.length, 4);
});

test('permanent YouTube permission failure does not create an upload or mark the batch ready', async (t) => {
  const h = await harness(t, { failParentUpload403: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'failed');
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
});

test('explicit parent upload 429 is safely queued, but a lost response stays uncertain', async (t) => {
  const rejected = await harness(t, { failParentUpload429: true });
  await rejected.processor(rejected.batch.id);
  assert.equal(rejected.drafts.get(rejected.batch.id).status, 'clip_retry_wait');
  assert.ok(Date.parse(rejected.drafts.get(rejected.batch.id).nextClipAttemptAt) > Date.now());
  assert.equal(rejected.counters.uploads.filter((upload) => upload.succeeded).length, 0);

  const ambiguous = await harness(t, { failParentUploadTimeout: true });
  await ambiguous.processor(ambiguous.batch.id);
  assert.equal(ambiguous.drafts.get(ambiguous.batch.id).status, 'clip_upload_uncertain');
  assert.equal(ambiguous.drafts.get(ambiguous.batch.id).productionState, 'manual_reconciliation');
  assert.equal(ambiguous.drafts.get(ambiguous.batch.id).youtubeVideoId, undefined);
  assert.equal(ambiguous.counters.uploads.filter((upload) => upload.succeeded).length, 0);
});

test('explicit Short 403 remains failed and can be retried after owner fixes access', async (t) => {
  const h = await harness(t, { failShort403: true });
  await h.processor(h.batch.id);
  const short = [...h.drafts.values()].find((draft) => draft.sourceType === 'twitch_highlight_short');
  assert.equal(short.status, 'clip_failed');
  assert.equal(short.uploadRejectionStatus, 403);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_partial');
  assert.equal(short.youtubeVideoId, null);

  // This second invocation models the owner explicitly retrying the parent after fixing OAuth.
  await h.processor(h.batch.id);
  const retried = h.drafts.get(short.id);
  assert.equal(retried.uploadRejectionStatus, null);
  assert.ok(retried.youtubeVideoId);
  assert.equal(h.counters.uploads.filter((upload) => upload.kind === 'short' && upload.succeeded).length, 3);
});

test('transient failures use bounded backoff attempts, while authorization errors are permanent', async (t) => {
  const h = await harness(t, { failClipCreateAlways: true });
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await h.processor(h.batch.id);
    assert.equal(h.drafts.get(h.batch.id).clipAttemptCount, attempt);
    assert.equal(h.drafts.get(h.batch.id).status, attempt < 12 ? 'clip_retry_wait' : 'clip_failed');
  }
  assert.equal(h.drafts.get(h.batch.id).nextClipAttemptAt, null);
  assert.equal(isTransientError({ status: 429 }), true);
  assert.equal(isTransientError({ statusCode: 503 }), true);
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError({ status: 403 }), false);
});

test('duplicate VOD events merge a later retry lease into the pending queue job', async () => {
  const existing = { sourceType: 'twitch_highlight_batch', vodId: '1234567890', id: 'existing' };
  assert.equal(findHighlightBatchByVodId([existing], '1234567890'), existing);
  assert.equal(findHighlightBatchByVodId([existing], '1234567891'), null);
  const scheduled = [];
  const processed = [];
  const queue = createBatchQueue(async (id, options) => { processed.push({ id, options }); },
    { schedule: (fn) => scheduled.push(fn) });
  assert.equal(queue.enqueue('existing'), true);
  assert.equal(queue.enqueue('existing'), false);
  assert.equal(queue.enqueue('existing', { retryLeaseClaimToken: 'fresh-claim' }), true);
  assert.equal(queue.enqueue('second'), true);
  await queue.drain();
  assert.deepEqual(processed, [
    { id: 'existing', options: { retryLeaseClaimToken: 'fresh-claim' } },
    { id: 'second', options: null }
  ]);
  assert.equal(queue.queuedCount, 0);
  assert.equal(scheduled.length, 1);
});

test('only long pending Twitch metadata retries are pulled forward', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  const pending = {
    sourceType: 'twitch_highlight_batch', status: 'clip_retry_wait',
    error: 'Twitch clip metadata is not linked to the requested VOD yet after 72 checks',
    nextClipAttemptAt: new Date(now + 10 * 60 * 1000).toISOString()
  };
  assert.equal(shouldPullForwardTwitchMetadataRetry(pending, now), true);
  assert.equal(shouldPullForwardTwitchMetadataRetry({
    ...pending, nextClipAttemptAt: new Date(now + 90 * 1000).toISOString()
  }, now), false);
  assert.equal(shouldPullForwardTwitchMetadataRetry({
    ...pending, error: 'YouTube upload quota exceeded'
  }, now), false);
  assert.equal(shouldPullForwardTwitchMetadataRetry({
    ...pending, sourceType: 'youtube_upload'
  }, now), false);
});

test('retry scanner selects only due highlight batches', () => {
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const due = { id: 'due', sourceType: 'twitch_highlight_batch', status: 'clip_retry_wait',
    nextClipAttemptAt: '2026-10-03T11:59:00.000Z' };
  const future = { id: 'future', sourceType: 'twitch_highlight_batch', status: 'clip_retry_wait',
    nextClipAttemptAt: '2026-10-03T12:01:00.000Z' };
  const unrelated = { id: 'public', sourceType: 'youtube_upload', status: 'clip_retry_wait',
    nextClipAttemptAt: '2026-10-03T11:00:00.000Z' };
  assert.deepEqual(findDueHighlightRetries([due, future, unrelated], now).map((draft) => draft.id), ['due']);
});

test('invalid measured render durations fail closed before YouTube upload', async (t) => {
  const h = await harness(t, { invalidDuration: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.equal(h.counters.uploads.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
});

test('impossible gameplay confidence or frame counts fail closed before YouTube upload', async (t) => {
  const h = await harness(t, { gameplayVerificationResult: {
    verified: true, activeGameplayFrames: 6, totalFrames: 5, confidence: 1.01, model: 'fixture'
  } });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.match(h.drafts.get(h.batch.id).error, /Gameplay visual gate rejected/);
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 0);
  assert.equal(h.counters.publications.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
});

test('an inaccurate Twitch VOD clip timestamp blocks all YouTube uploads', async (t) => {
  const h = await harness(t, { timestampDrift: 10 });
  h.batch.highlights[0].startSeconds = 20;
  h.batch.highlights[0].endSeconds = 50;
  h.batch.highlights[0].duration = 30;
  h.drafts.set(h.batch.id, h.batch);
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 0);
  assert.equal(h.counters.publications.length, 0);
});

test('a clip explicitly linked to a different VOD is rejected without polling or upload', async (t) => {
  const h = await harness(t, { wrongVodId: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_failed');
  assert.match(h.drafts.get(h.batch.id).error, /different VOD/);
  assert.equal(h.counters.clipMetadataChecks, 1);
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 0);
});

test('owner review waits until every YouTube upload and processing state is complete', async (t) => {
  const shortId = 'yt-short-moment-two';
  const h = await harness(t, { autoPublish: false,
    uploadStatuses: { [shortId]: ['uploaded', 'processed'] } });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'retry_scheduled');
  const pendingShort = [...h.drafts.values()].find((draft) => draft.youtubeVideoId === shortId);
  assert.equal(pendingShort.status, 'clip_partial');
  assert.equal(pendingShort.productionState, 'processing');
  assert.equal(h.counters.publications.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);

  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'awaiting_owner_approval');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'ready');
  const readyShort = [...h.drafts.values()].find((draft) => draft.youtubeVideoId === shortId);
  assert.equal(readyShort.status, 'awaiting_owner_approval');
  assert.equal(readyShort.productionState, 'ready');
  assert.equal(h.counters.publications.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
});

test('automatic publication waits for the complete bundle before making any output public', async (t) => {
  const shortId = 'yt-short-moment-two';
  const h = await harness(t, { processingStatuses: {
    [shortId]: ['processing', 'succeeded']
  } });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'retry_scheduled');
  assert.equal(h.counters.publications.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
  assert.ok(h.counters.uploads.every((upload) => upload.privacyStatus === 'private'));

  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.counters.publications.length, 4);
  assert.equal(h.counters.visibilityMutations, 4);
});

test('every video and Short must finish YouTube processing before any bundle output can publish', async (t) => {
  const outputIds = ['yt-parent', 'yt-short-moment-one', 'yt-short-moment-two', 'yt-short-moment-three'];
  for (const outputId of outputIds) {
    const h = await harness(t, { processingStatuses: { [outputId]: ['processing', 'succeeded'] } });
    await h.processor(h.batch.id);
    assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait', outputId);
    assert.equal(h.counters.publications.length, 0, outputId);
    assert.equal(h.counters.visibilityMutations, 0, outputId);
    assert.ok(h.counters.uploads.every((upload) => upload.privacyStatus === 'private'), outputId);

    await h.processor(h.batch.id);
    assert.equal(h.drafts.get(h.batch.id).status, 'completed', outputId);
    assert.equal(h.counters.publications.length, 4, outputId);
  }
});

test('active and upcoming YouTube livestream outputs cannot pass the finished media gate', async (t) => {
  for (const [outputId, state] of [['yt-parent', 'live'], ['yt-short-moment-one', 'upcoming']]) {
    const h = await harness(t, { liveBroadcastContent: { [outputId]: state } });
    await h.processor(h.batch.id);
    assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait', outputId);
    assert.equal(h.counters.publications.length, 0, outputId);
    assert.equal(h.counters.visibilityMutations, 0, outputId);
  }
});

test('terminated YouTube processing details do not count as a finished output', async (t) => {
  const shortId = 'yt-short-moment-one';
  const h = await harness(t, { processingStatuses: { [shortId]: ['terminated'] } });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'retry_scheduled');
  assert.equal(h.counters.publications.length, 0);
  assert.equal(h.counters.visibilityMutations, 0);
});

test('failed uploads and unlisted outputs stop automatic publication before any write', async (t) => {
  const failed = await harness(t, { failedUploadVideoId: 'yt-short-moment-three' });
  await failed.processor(failed.batch.id);
  assert.equal(failed.drafts.get(failed.batch.id).status, 'clip_partial');
  assert.equal(failed.counters.publications.length, 0);
  assert.equal(failed.counters.visibilityMutations, 0);
  const failedShort = [...failed.drafts.values()].find((draft) =>
    draft.youtubeVideoId === 'yt-short-moment-three');
  assert.equal(failedShort.productionState, 'partial');

  const unlisted = await harness(t, { unlistedVideoId: 'yt-short-moment-two' });
  await unlisted.processor(unlisted.batch.id);
  assert.equal(unlisted.drafts.get(unlisted.batch.id).status, 'clip_partial');
  assert.equal(unlisted.counters.publications.length, 0);
  assert.equal(unlisted.counters.visibilityMutations, 0);
});

test('YouTube processing and output validation must pass before any automatic publication', async (t) => {
  const h = await harness(t, { unprocessedVideoId: 'yt-parent' });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'retry_scheduled');
  assert.equal(h.counters.publications.length, 0);

  const failedMedia = await harness(t, { failShortValidation: true });
  await failedMedia.processor(failedMedia.batch.id);
  assert.equal(failedMedia.drafts.get(failedMedia.batch.id).status, 'clip_partial');
  assert.equal(failedMedia.counters.publications.length, 0);
});

test('automatic publication keeps retrying while YouTube processing is still underway', async (t) => {
  const h = await harness(t, { processingStatuses: {
    'yt-parent': [...Array(6).fill('processing'), 'succeeded']
  } });
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    await h.processor(h.batch.id);
    assert.equal(h.drafts.get(h.batch.id).clipAttemptCount, attempt);
    assert.equal(h.drafts.get(h.batch.id).status, attempt < 7 ? 'clip_retry_wait' : 'completed');
  }
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 4);
  assert.equal(h.counters.publications.length, 4);
});

test('transient publication failure resumes from the first still-private output', async (t) => {
  const h = await harness(t, { failPublishOnce: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.equal(h.drafts.get(h.batch.id).publicationStatus, 'retry');
  assert.equal(h.counters.publications.length, 2);
  const firstShort = [...h.drafts.values()].find((draft) => draft.highlightIndex === 0);
  assert.equal(firstShort.publicationStatus, 'retry');
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'completed');
  assert.equal(h.counters.uploads.filter((upload) => upload.succeeded).length, 4);
  assert.equal(h.counters.publications.length, 5);
});

test('excluded highlight batches stop before any worker or YouTube processing', async (t) => {
  const h = await harness(t);
  h.batch.status = 'excluded_by_owner';

  await h.processor(h.batch.id);

  assert.equal(h.drafts.get(h.batch.id).status, 'excluded_by_owner');
  assert.equal(h.counters.clipCreates, 0);
  assert.equal(h.counters.uploads.length, 0);
  assert.equal(h.counters.thumbnailCreates, 0);
  assert.equal(h.counters.publications.length, 0);
});

test('old private batches and disabled automatic publication remain private for owner review', async (t) => {
  const old = await harness(t);
  old.batch.autoPublishEligible = false;
  old.drafts.set(old.batch.id, old.batch);
  await old.processor(old.batch.id);
  assert.equal(old.drafts.get(old.batch.id).status, 'awaiting_owner_approval');
  assert.equal(old.counters.publications.length, 0);
  assert.deepEqual(old.counters.readyLogs, [{ batchId: 'batch-1', shortCount: 3 }]);

  const disabled = await harness(t, { autoPublish: false });
  await disabled.processor(disabled.batch.id);
  assert.equal(disabled.drafts.get(disabled.batch.id).status, 'awaiting_owner_approval');
  assert.equal(disabled.counters.publications.length, 0);
  assert.deepEqual(disabled.counters.readyLogs, [{ batchId: 'batch-1', shortCount: 3 }]);
});

test('permanent publication permission failure stops with owner review and leaves remaining outputs private', async (t) => {
  const h = await harness(t, { failPublishPermanently: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'awaiting_owner_approval');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'ready');
  assert.equal(h.drafts.get(h.batch.id).publicationStatus, 'failed');
  assert.equal(h.counters.publications.length, 1);
});


test('metadata polling yields long Twitch Retry-After windows to the durable retry queue', async () => {
  const sleeps = [];
  let calls = 0;
  const error = Object.assign(new Error('Twitch rate limit'), {
    status: 429, retryAfterMs: 60 * 60 * 1000
  });
  await assert.rejects(waitForVerifiedClipMetadata({
    getClip: async () => { calls += 1; throw error; },
    moment: { startSeconds: 30, endSeconds: 60, duration: 30 },
    vodId: '1234567890',
    sleep: async (ms) => { sleeps.push(ms); },
    pollIntervalMs: 5000,
    maxAttempts: 10
  }), (caught) => caught === error);
  assert.equal(calls, 1, 'the poller must not call Twitch before the one-hour reset');
  assert.deepEqual(sleeps, []);
});
