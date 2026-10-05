'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBatchQueue, createHighlightProcessor, findDueHighlightRetries,
  findHighlightBatchByVodId, isTransientError } = require('../src/highlight-pipeline');
const { buildHighlightTimeline, buildHighlightDescription } = require('../src/highlight-metadata');

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
    clipCreates: 0, uploads: [], thumbnailSets: 0, thumbnailCreates: 0,
    thumbnailSource: null, thumbnailOptions: null,
    shortRenders: 0, seo: [], playlists: [], visibilityMutations: 0,
    publicationChecks: [], publications: [], errors: []
  };
  const processingChecks = new Map();
  let listFailureUsed = false;
  let clipFailureUsed = false;
  let thumbnailUploadFailureUsed = false;
  let thumbnailCreateFailureUsed = false;
  let shortFailureUsed = false;
  let seoFailureUsed = false;
  let idCounter = 0;

  const copy = (value) => value && structuredClone(value);
  const store = {
    async getDraft(id) { return copy(drafts.get(id)); },
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
      if (!current) return null;
      const next = { ...current, ...copy(patch), updatedAt: new Date().toISOString() };
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
      const end = Number(String(clipId).slice('clip-'.length));
      return { id: clipId, video_id: '1234567890', vod_offset: end - 30 + (options.timestampDrift || 0), duration: 30 };
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
    async assembleHighlights(sources, destination) {
      await fs.writeFile(destination, 'fixture montage');
      return options.invalidDuration ? sources.map(() => 0) : sources.map(() => 30);
    },
    async validateHighlight() {
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
      if (isShort && options.failShortTitle === request.title && !shortFailureUsed) {
        shortFailureUsed = true;
        throw Object.assign(new Error('YouTube upload quota exceeded'), { status: 429 });
      }
      if (!isShort && options.failParentUpload403) {
        throw Object.assign(new Error('YouTube upload forbidden'), { status: 403 });
      }
      call.succeeded = true;
      const id = isShort ? 'yt-short-' + request.title.toLowerCase().replaceAll(' ', '-') : 'yt-parent';
      call.id = id;
      youtubeVideos.set(id, 'private');
      return { id };
    },
    async getVideo(videoId) {
      counters.publicationChecks.push(videoId);
      const checkNumber = (processingChecks.get(videoId) || 0) + 1;
      processingChecks.set(videoId, checkNumber);
      const privacyStatus = youtubeVideos.get(videoId) || options.initialPrivacyStatus || 'private';
      const sequence = options.processingStatuses?.[videoId];
      const processingStatus = Array.isArray(sequence)
        ? sequence[Math.min(checkNumber - 1, sequence.length - 1)]
        : options.unprocessedVideoId === videoId ? 'processing'
        : options.failedProcessingVideoId === videoId ? 'failed' : 'succeeded';
      return { id: videoId, status: { privacyStatus }, processingDetails: { processingStatus } };
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
      if (options.failSeoTitle === payload.title && !seoFailureUsed) {
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
    autoPublish: options.autoPublish !== false,
    maxAutoAttempts: options.maxAutoAttempts,
    idFactory: () => 'short-draft-' + (++idCounter),
    logError: (_id, error) => counters.errors.push(error.message)
  };
  const processor = createHighlightProcessor(dependencies);
  return { batch, drafts, store, counters, processor,
    createProcessor: () => createHighlightProcessor(dependencies) };
}

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
  assert.equal(h.counters.publicationChecks.length, 4);
});

test('a transient Short upload failure schedules retry, then finishes without duplicate uploads', async (t) => {
  const h = await harness(t, { failShortTitle: 'Moment two' });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'clip_retry_wait');
  assert.ok(Date.parse(h.drafts.get(h.batch.id).nextClipAttemptAt) > Date.now());
  assert.match(h.drafts.get(h.batch.id).error, /Short 2/);
  assert.equal([...h.drafts.values()].filter((draft) => draft.sourceType === 'twitch_highlight_short').length, 2);
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

test('duplicate VOD events resolve to the same batch and queue only one active job', async () => {
  const existing = { sourceType: 'twitch_highlight_batch', vodId: '1234567890', id: 'existing' };
  assert.equal(findHighlightBatchByVodId([existing], '1234567890'), existing);
  assert.equal(findHighlightBatchByVodId([existing], '1234567891'), null);
  const scheduled = [];
  const processed = [];
  const queue = createBatchQueue(async (id) => { processed.push(id); }, { schedule: (fn) => scheduled.push(fn) });
  assert.equal(queue.enqueue('existing'), true);
  assert.equal(queue.enqueue('existing'), false);
  assert.equal(queue.enqueue('second'), true);
  await queue.drain();
  assert.deepEqual(processed, ['existing', 'second']);
  assert.equal(queue.queuedCount, 0);
  assert.equal(scheduled.length, 1);
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

test('old private batches and disabled automatic publication remain private for owner review', async (t) => {
  const old = await harness(t);
  old.batch.autoPublishEligible = false;
  old.drafts.set(old.batch.id, old.batch);
  await old.processor(old.batch.id);
  assert.equal(old.drafts.get(old.batch.id).status, 'awaiting_owner_approval');
  assert.equal(old.counters.publications.length, 0);

  const disabled = await harness(t, { autoPublish: false });
  await disabled.processor(disabled.batch.id);
  assert.equal(disabled.drafts.get(disabled.batch.id).status, 'awaiting_owner_approval');
  assert.equal(disabled.counters.publications.length, 0);
});

test('permanent publication permission failure stops with owner review and leaves remaining outputs private', async (t) => {
  const h = await harness(t, { failPublishPermanently: true });
  await h.processor(h.batch.id);
  assert.equal(h.drafts.get(h.batch.id).status, 'awaiting_owner_approval');
  assert.equal(h.drafts.get(h.batch.id).productionState, 'ready');
  assert.equal(h.drafts.get(h.batch.id).publicationStatus, 'failed');
  assert.equal(h.counters.publications.length, 1);
});
