'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateHighlightMoments, verifyCreatedClip, verifyClipCreationRequest } = require('./highlight-validation');
const { buildHighlightTitle: defaultBuildHighlightTitle, buildShortTitle: defaultBuildShortTitle,
  buildShortDescription: defaultBuildShortDescription } = require('./highlight-metadata');

function createBatchQueue(processJob, options = {}) {
  const schedule = options.schedule || setImmediate;
  const onError = options.onError || (() => {});
  const jobs = [];
  const queuedIds = new Set();
  let draining = false;
  let scheduled = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (jobs.length) {
        const id = jobs.shift();
        try {
          await processJob(id);
        } catch (error) {
          onError(id, error);
        } finally {
          queuedIds.delete(id);
        }
      }
    } finally {
      draining = false;
      if (jobs.length) requestDrain();
    }
  }

  function requestDrain() {
    if (scheduled || draining) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void drain();
    });
  }

  function enqueue(id) {
    if (id === null || id === undefined || queuedIds.has(String(id))) return false;
    const value = String(id);
    queuedIds.add(value);
    jobs.push(value);
    requestDrain();
    return true;
  }

  return {
    enqueue,
    drain,
    get queuedCount() { return jobs.length + (draining ? 1 : 0); }
  };
}

function findHighlightBatchByVodId(drafts, vodId) {
  const requestedId = String(vodId);
  return drafts.find((draft) => draft.sourceType === 'twitch_highlight_batch' &&
    String(draft.vodId) === requestedId) || null;
}

function findDueHighlightRetries(drafts, now = Date.now()) {
  return drafts.filter((draft) => draft.sourceType === 'twitch_highlight_batch' &&
    draft.status === 'clip_retry_wait' && Date.parse(draft.nextClipAttemptAt || 0) <= now);
}

function shouldRequeueUnexpectedTwitchDownloadHost(draft) {
  return draft?.sourceType === 'twitch_highlight_batch' &&
    draft.status === 'clip_failed' &&
    String(draft.error || '').startsWith('Twitch returned an unexpected clip download host') &&
    !draft.twitchDownloadHostDiagnosticRetryAt;
}

function shouldRequeueTwitchSegmentDurationFailure(draft) {
  return draft?.sourceType === 'twitch_highlight_batch' &&
    ['clip_failed', 'clip_retry_wait'].includes(draft.status) &&
    String(draft.error || '').startsWith('Every highlight segment needs a measured duration between 5 and 60 seconds') &&
    !draft.twitchSegmentDurationRetryAt;
}

function shouldPullForwardAllowedTwitchDownloadHost(draft) {
  const expectedError = 'Twitch returned an unexpected clip download host: d1ndex63qxojbr.cloudfront.net';
  return draft?.sourceType === 'twitch_highlight_batch' &&
    ['clip_failed', 'clip_retry_wait'].includes(draft.status) &&
    String(draft.error || '').includes(expectedError) &&
    !draft.twitchDownloadHostAllowlistRetryAt;
}

function shouldPullForwardTwitchMetadataRetry(draft, now = Date.now(), minimumDelayMs = 2 * 60 * 1000) {
  const nextAttemptAt = Date.parse(draft && draft.nextClipAttemptAt || '');
  const minimumDelay = Math.max(0, Number(minimumDelayMs) || 0);
  return draft?.sourceType === 'twitch_highlight_batch' &&
    draft.status === 'clip_retry_wait' &&
    String(draft.error || '').includes('Twitch clip metadata is not linked to the requested VOD yet') &&
    Number.isFinite(nextAttemptAt) && nextAttemptAt > Number(now) + minimumDelay;
}

function isTransientError(error) {
  const status = Number(error && (error.status || error.statusCode || error.response && error.response.status));
  if ([408, 425, 429].includes(status) || status >= 500 && status <= 599) return true;
  const code = String(error && (error.code || error.cause && error.cause.code) || '').toUpperCase();
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code);
}

async function waitForVerifiedClipMetadata({
  getClip, moment, vodId, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 5000, maxAttempts = 72
}) {
  if (typeof getClip !== 'function') throw new Error('Twitch clip metadata lookup is unavailable');
  const parsedAttempts = Math.floor(Number(maxAttempts));
  const attemptLimit = Number.isFinite(parsedAttempts) && parsedAttempts > 0
    ? Math.min(120, parsedAttempts) : 36;
  const parsedInterval = Number(pollIntervalMs);
  const interval = Number.isFinite(parsedInterval) && parsedInterval >= 0
    ? Math.min(30000, parsedInterval) : 5000;
  let lastError;
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    if (attempt > 0 && interval > 0) await sleep(interval);
    let lastClip = null;
    try {
      lastClip = await getClip();
      return verifyCreatedClip(moment, lastClip, vodId);
    } catch (error) {
      if (Number(error && error.status) === 425 && !error.code) {
        error.code = 'TWITCH_CLIP_METADATA_PENDING';
      }
      lastError = error;
      if (!isTransientError(error) || attempt === attemptLimit - 1) {
        if (error.code === 'TWITCH_CLIP_METADATA_PENDING' && lastClip) {
          error.message += ' after ' + (attempt + 1) + ' checks; last Twitch metadata: video_id=' +
            (String(lastClip.video_id || '').trim() || 'empty') + ', vod_offset=' +
            (lastClip.vod_offset ?? 'null') + ', duration=' + (lastClip.duration ?? 'null');
        }
        throw error;
      }
    }
  }
  throw lastError || new Error('Twitch clip metadata did not become available');
}

function requireCompletedYouTubeOutput(video, expectedVideoId, outputType = 'video') {
  if (!video) {
    const error = new Error('YouTube ' + outputType + ' is not available for processing checks yet');
    error.status = 425;
    throw error;
  }
  if (!expectedVideoId || video.id !== expectedVideoId) {
    const error = new Error('YouTube returned a missing or different video during processing checks');
    error.status = 409;
    throw error;
  }
  const uploadStatus = video.status?.uploadStatus;
  const processingStatus = video.processingDetails?.processingStatus;
  if (['deleted', 'failed', 'rejected'].includes(uploadStatus) ||
      ['failed'].includes(processingStatus)) {
    const reason = video.status?.rejectionReason || video.status?.failureReason ||
      video.processingDetails?.processingFailureReason;
    const error = new Error('YouTube ' + outputType + ' upload or processing failed' +
      (reason ? ': ' + reason : ''));
    error.status = 422;
    throw error;
  }
  if (video.snippet?.liveBroadcastContent !== 'none') {
    const error = new Error('YouTube ' + outputType + ' is active, upcoming, or missing live-status confirmation');
    error.status = 425;
    throw error;
  }
  if (uploadStatus !== 'processed' || processingStatus !== 'succeeded') {
    const error = new Error('YouTube has not confirmed this ' + outputType + ' is fully processed');
    error.status = 425;
    throw error;
  }
  return video;
}

function createHighlightProcessor(dependencies) {
  const {
    uploadDir, store, twitch, video, youtube, seo, autoAssignPlaylist,
    buildHighlightTimeline, buildHighlightDescription,
    buildHighlightTitle = defaultBuildHighlightTitle, buildShortTitle = defaultBuildShortTitle,
    buildShortDescription = defaultBuildShortDescription, cleanText,
    idFactory = () => crypto.randomUUID(), logError = () => {}, logSuccess = () => {},
    maxAutoAttempts = 12, autoPublish = true, now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clipMetadataPollIntervalMs = 5000, clipMetadataMaxAttempts = 72
  } = dependencies;

  async function registerSeo(draftId, videoId, payload, label, failures, noteFailure) {
    try {
      await seo.registerUpload(videoId, payload);
      await store.updateDraft(draftId, { seoRegistrationStatus: 'registered', seoRegistrationError: null });
      return true;
    } catch (error) {
      const reason = noteFailure(label, error, 250);
      await store.updateDraft(draftId, { seoRegistrationStatus: 'failed', seoRegistrationError: reason });
      return false;
    }
  }

  async function processHighlightBatch(id) {
    const directory = path.join(uploadDir, 'highlights-' + id);
    let batch;
    try {
      batch = await store.getDraft(id);
      if (!batch || batch.sourceType !== 'twitch_highlight_batch' || batch.status === 'completed' ||
          batch.status === 'awaiting_owner_approval' && batch.productionState === 'ready') return;
      if (['twitch_clips_api', 'twitch_live_capture'].includes(batch.discoverySource) &&
          !(Number.isFinite(Number(batch.targetHighlightDurationSeconds)) &&
            Number(batch.targetHighlightDurationSeconds) > 0)) {
        throw new Error('Legacy Twitch highlight has no measured target duration; keeping it private');
      }
      if (!Array.isArray(batch.highlights) || !batch.highlights.length) {
        throw new Error('Highlight batch has no valid moments to produce');
      }
      if (batch.autoPublishEligible) {
        validateHighlightMoments(batch.highlights, batch.vodDurationSeconds);
      }
      const targetHighlightDurationSeconds = Number(batch.targetHighlightDurationSeconds);
      if (Number.isFinite(targetHighlightDurationSeconds) && targetHighlightDurationSeconds > 0) {
        const selectedDuration = batch.highlights.reduce((sum, moment) => sum + Number(moment.duration || 0), 0);
        if (Math.abs(selectedDuration - targetHighlightDurationSeconds) > 0.1) {
          throw new Error(`Selected gameplay segments total ${selectedDuration.toFixed(1)} seconds; exactly ${targetHighlightDurationSeconds} seconds are required`);
        }
      }

      const attemptCount = (Number(batch.clipAttemptCount) || 0) + 1;
      const failures = [];
      let hasRetryableFailure = false;
      let hasPermanentFailure = false;
      const noteFailure = (label, error, maxLength = 250) => {
        const reason = cleanText(error && error.message || 'Production step failed', maxLength);
        failures.push(label + ': ' + reason);
        if (isTransientError(error)) hasRetryableFailure = true;
        else hasPermanentFailure = true;
        return reason;
      };
      await fs.promises.mkdir(directory, { recursive: true });
      await store.updateDraft(id, {
        status: 'creating_twitch_clips', productionState: 'processing',
        clipAttemptCount: attemptCount, nextClipAttemptAt: null, error: null, productionFailures: []
      });

      const sources = [];
      const twitchClips = [...(batch.twitchClips || [])];
      for (let index = 0; index < batch.highlights.length; index += 1) {
        const moment = batch.highlights[index];
        let clip = twitchClips[index];
        if (!clip) {
          const requestedVodOffset = Math.round(moment.endSeconds);
          const requestedDuration = Number(moment.duration.toFixed(1));
          const created = await twitch.createClipFromVod({
            vodId: batch.vodId, vodOffset: requestedVodOffset,
            duration: requestedDuration, title: moment.title
          });
          clip = {
            ...created,
            requestedVodId: String(batch.vodId),
            requestedVodOffset,
            requestedDuration,
            requestProofVersion: 1,
            requestProofReconstructed: false
          };
          twitchClips[index] = clip;
          await store.updateDraft(id, { twitchClips });
        } else if (['twitch_clips_api', 'twitch_live_capture'].includes(batch.discoverySource) &&
            clip.requestProofVersion !== 1) {
          // Older Amaana batches stored the clip ID but not the request fields. This pipeline
          // created those IDs from this VOD and moment, so persist the original request shape.
          clip = {
            ...clip,
            requestedVodId: String(batch.vodId),
            requestedVodOffset: Math.round(moment.endSeconds),
            requestedDuration: Number(moment.duration.toFixed(1)),
            requestProofVersion: 1,
            requestProofReconstructed: true
          };
          twitchClips[index] = clip;
          await store.updateDraft(id, { twitchClips });
        }
        const download = await twitch.waitForClipDownload({
          clipId: clip.id, broadcasterId: clip.broadcasterId, editorId: clip.editorId
        });
        if (typeof twitch.getClip !== 'function') throw new Error('Twitch clip timestamp verification is unavailable');
        let verifiedTimestamp;
        if (['twitch_clips_api', 'twitch_live_capture'].includes(batch.discoverySource)) {
          try {
            verifiedTimestamp = verifyCreatedClip(moment, await twitch.getClip(clip.id), batch.vodId);
          } catch (error) {
            if (Number(error && error.status) !== 425) throw error;
            // Twitch may leave video_id and vod_offset empty after clip media is downloadable.
            // Use the exact accepted VOD request only for Amaana-created VOD clips; non-pending
            // metadata mismatches still fail closed above.
            verifiedTimestamp = verifyClipCreationRequest(moment, clip, batch.vodId);
          }
        } else {
          verifiedTimestamp = await waitForVerifiedClipMetadata({
            getClip: () => twitch.getClip(clip.id),
            moment,
            vodId: batch.vodId,
            sleep,
            pollIntervalMs: clipMetadataPollIntervalMs,
            maxAttempts: clipMetadataMaxAttempts
          });
        }
        twitchClips[index] = { ...twitchClips[index], timestampVerification: verifiedTimestamp };
        await store.updateDraft(id, { twitchClips });
        const url = download.landscape_download_url;
        if (!url) throw new Error('Twitch clip has no landscape gameplay source; portrait-only Twitch media is rejected');
        const source = path.join(directory, 'source-' + index + '.mp4');
        await twitch.downloadClip(url, source);
        if (typeof video.verifyGameplay !== 'function') {
          throw new Error('Visual gameplay verification is unavailable; no video was uploaded');
        }
        const visualGameplay = await video.verifyGameplay(source);
        if (!visualGameplay?.verified) {
          const active = Number(visualGameplay?.activeGameplayFrames) || 0;
          const total = Number(visualGameplay?.totalFrames) || 0;
          throw new Error(`Gameplay visual gate rejected Twitch clip ${clip.id}: only ${active} of ${total} sampled frames clearly showed active gameplay`);
        }
        twitchClips[index] = {
          ...twitchClips[index],
          visualGameplayVerification: {
            verified: true,
            activeGameplayFrames: Number(visualGameplay.activeGameplayFrames),
            totalFrames: Number(visualGameplay.totalFrames),
            confidence: Number(visualGameplay.confidence),
            gameName: cleanText(visualGameplay.gameName || '', 100),
            model: cleanText(visualGameplay.model || '', 80)
          }
        };
        await store.updateDraft(id, { twitchClips });
        sources.push(source);
      }

      const montage = path.join(directory, 'highlight.mp4');
      await store.updateDraft(id, { status: 'assembling_highlight_video' });
      const durations = await video.assembleHighlights(sources, montage, directory,
        batch.highlights.map((moment) => Number(moment.duration)),
        Number.isFinite(targetHighlightDurationSeconds) ? targetHighlightDurationSeconds : null);
      const timeline = buildHighlightTimeline(batch.highlights, durations);
      await video.validateHighlight(montage,
        Number.isFinite(targetHighlightDurationSeconds) ? targetHighlightDurationSeconds : timeline.durationSeconds,
        { exactDuration: Number.isFinite(targetHighlightDurationSeconds) });
      const description = batch.pipelineVersion >= 2
        ? buildHighlightDescription(batch.vodId, timeline, batch.streamTitle)
        : 'Highlights from https://www.twitch.tv/videos/' + batch.vodId;
      const highlightTitle = buildHighlightTitle(batch.streamTitle || 'Saevond livestream', timeline);
      const highlightTags = ['@saevond', 'gaming', 'livestream highlights'];
      const thumbnailPath = path.join(directory, 'highlight-thumbnail.jpg');
      let thumbnailStatus = batch.thumbnailStatus || 'pending';
      let thumbnailError = null;
      let thumbnailHeadline = batch.thumbnailHeadline || '';
      let thumbnailReady = false;

      if (batch.pipelineVersion >= 2 && thumbnailStatus !== 'applied') {
        const selectedIndex = batch.highlights.reduce((best, item, index, all) =>
          (Number(item.score) || 0) > (Number(all[best] && all[best].score) || 0) ? index : best, 0);
        const selected = batch.highlights[selectedIndex];
        const frameOffset = Math.min(durations[selectedIndex] / 2,
          Math.max(0.25, durations[selectedIndex] - 0.25));
        thumbnailHeadline = video.thumbnailHeadline(selected.title || highlightTitle);
        try {
          // The montage is normalized to 1280x720. Extract from the original Twitch clip instead
          // so the thumbnail renderer can retain any higher-resolution source frames.
          await video.createThumbnail(sources[selectedIndex] || montage, thumbnailPath, {
            timestampSeconds: frameOffset, headline: thumbnailHeadline
          });
          thumbnailReady = true;
          thumbnailStatus = 'generated';
        } catch (error) {
          thumbnailStatus = 'failed';
          thumbnailError = noteFailure('thumbnail', error, 300);
        }
      }

      const highlight = batch.youtubeVideoId ? { id: batch.youtubeVideoId } : await youtube.uploadPrivate({
        filePath: montage,
        title: highlightTitle,
        description,
        tags: highlightTags
      });
      const highlightPatch = {
        status: 'creating_shorts', productionState: 'processing', youtubeVideoId: highlight.id,
        title: highlightTitle, description, tags: highlightTags,
        duration: Number.isFinite(targetHighlightDurationSeconds) ? targetHighlightDurationSeconds : timeline.durationSeconds,
        mediaValidation: 'passed'
      };
      if (batch.pipelineVersion >= 2) {
        Object.assign(highlightPatch, {
          chapterTimestamps: timeline.timestamps.map(({ time, title }) => ({ time, title })),
          chapters: timeline.chapters.map(({ time, title }) => ({ time, title })),
          chapterStatus: timeline.chapters.length >= 3 ? 'chapters_added' : 'timestamps_only',
          thumbnailStatus, thumbnailError, thumbnailHeadline
        });
      }
      // Persist the private parent ID before downstream work so a retry can reuse it.
      await store.updateDraft(id, highlightPatch);

      const playlistAssignment = await autoAssignPlaylist({
        id: highlight.id, privacyStatus: 'private', title: highlightTitle, description,
        tags: highlightTags,
        context: { topic: batch.streamTitle || '', takeaways: batch.highlights.map((moment) =>
          moment.title + ': ' + moment.reason).join('\n'), videoType: 'Gameplay' }
      });
      await store.updateDraft(id, { playlistAssignment });

      if (batch.pipelineVersion >= 2 && thumbnailReady) {
        try {
          await youtube.setThumbnail(highlight.id, thumbnailPath);
          thumbnailStatus = 'applied';
          thumbnailError = null;
        } catch (error) {
          thumbnailStatus = 'failed';
          thumbnailError = noteFailure('thumbnail', error, 300);
        }
        await store.updateDraft(id, { thumbnailStatus, thumbnailError, thumbnailHeadline });
      }
      if (batch.pipelineVersion >= 2 && thumbnailStatus !== 'applied') {
        if (!failures.some((failure) => failure.startsWith('thumbnail: '))) {
          noteFailure('thumbnail', new Error(thumbnailError || 'thumbnail is not applied'));
        }
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
      const highlightSeoPayload = {
        title: highlightTitle, description, tags: highlightTags, durationSeconds: markerOffset,
        context: { topic: batch.streamTitle || '', takeaways: batch.highlights.map((moment) =>
          moment.title + ': ' + moment.reason).join('\n'), videoType: 'Gameplay' },
        markers
      };
      const parentState = await store.getDraft(id);
      if (parentState.seoRegistrationStatus !== 'registered') {
        await registerSeo(id, highlight.id, highlightSeoPayload, 'highlight SEO', failures, noteFailure);
      }

      const existingShorts = (await store.listDrafts()).filter((draft) => draft.parentId === id);
      const shortsByIndex = new Map(existingShorts.map((draft) => [draft.highlightIndex, draft]));
      const shortIndexes = new Set(Array.isArray(batch.shortCandidateIndexes)
        ? batch.shortCandidateIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < batch.highlights.length)
        : batch.highlights.map((_moment, index) => index));
      const expectedShortCount = shortIndexes.size;
      const registeredShortIndexes = new Set();
      let offset = 0;
      for (let index = 0; index < batch.highlights.length; index += 1) {
        const moment = batch.highlights[index];
        if (!shortIndexes.has(index)) {
          offset += durations[index];
          continue;
        }
        const length = Math.min(60, durations[index]);
        const shortTags = ['@saevond', 'gaming', 'Shorts'];
        const existingShort = shortsByIndex.get(index);
        const seenShortTitles = [highlightTitle, ...[...shortsByIndex.entries()]
          .filter(([shortIndex]) => Number(shortIndex) !== index)
          .map(([, short]) => short.title).filter(Boolean)];
        const shortTitle = existingShort?.title || buildShortTitle(moment, batch.streamTitle, seenShortTitles);
        const shortDescription = existingShort?.description ||
          buildShortDescription(batch.vodId, highlight.id, moment, batch.streamTitle);
        if (existingShort && existingShort.youtubeVideoId) {
          if (existingShort.publicationStatus !== 'published') {
            await store.updateDraft(existingShort.id, { status: 'clip_partial', productionState: 'processing' });
          }
          if (existingShort.seoRegistrationStatus !== 'registered') {
            const payload = {
              title: shortTitle,
              description: existingShort.description || shortDescription,
              tags: existingShort.tags || shortTags,
              durationSeconds: length,
              context: { takeaways: moment.reason || moment.title, videoType: 'Gameplay' },
              markers: [{ kind: 'clip', startSeconds: 0, endSeconds: length,
                title: moment.title, provenance: 'twitch_highlight' }]
            };
            const registered = await registerSeo(existingShort.id, existingShort.youtubeVideoId,
              payload, 'Short ' + (index + 1) + ' SEO', failures, noteFailure);
            if (registered) {
              registeredShortIndexes.add(index);
            } else {
              await store.updateDraft(existingShort.id, { status: 'clip_partial', productionState: 'partial' });
            }
          } else {
            registeredShortIndexes.add(index);
          }
          offset += durations[index];
          continue;
        }

        const shortPath = path.join(directory, 'short-' + index + '.mp4');
        try {
          await video.shortFromHighlight(montage, offset, length, shortPath);
          await video.validateShort(shortPath, length);
          const uploaded = await youtube.uploadPrivate({
            filePath: shortPath, title: shortTitle, description: shortDescription, tags: shortTags
          });
          const shortDraft = {
            id: idFactory(), sourceType: 'twitch_highlight_short', parentId: id,
            highlightIndex: index, vodId: batch.vodId, title: shortTitle,
            description: shortDescription, tags: shortTags, youtubeVideoId: uploaded.id,
            mediaValidation: 'passed', playlistAssignment: { state: 'pending' },
            status: 'clip_partial', productionState: 'processing',
            seoRegistrationStatus: 'pending', publicationStatus: 'pending',
            createdAt: new Date().toISOString()
          };
          // Record the YouTube ID before playlist and SEO work so a retry can reuse the Short.
          await store.addDraft(shortDraft);
          shortsByIndex.set(index, shortDraft);
          const playlist = await autoAssignPlaylist({
            id: uploaded.id, privacyStatus: 'private', title: shortTitle,
            description: shortDescription, tags: shortTags,
            context: { takeaways: moment.reason || moment.title, videoType: 'Gameplay' }
          });
          await store.updateDraft(shortDraft.id, { playlistAssignment: playlist });
          const registered = await registerSeo(shortDraft.id, uploaded.id, {
            title: shortTitle, description: shortDescription, tags: shortTags,
            durationSeconds: length,
            context: { takeaways: moment.reason || moment.title, videoType: 'Gameplay' },
            markers: [{ kind: 'clip', startSeconds: 0, endSeconds: length,
              title: moment.title, provenance: 'twitch_highlight' }]
          }, 'Short ' + (index + 1) + ' SEO', failures, noteFailure);
          if (registered) {
            registeredShortIndexes.add(index);
          } else {
            await store.updateDraft(shortDraft.id, { status: 'clip_partial', productionState: 'partial' });
          }
        } catch (error) {
          noteFailure('Short ' + (index + 1), error, 150);
        }
        offset += durations[index];
      }

      if (registeredShortIndexes.size !== expectedShortCount) {
        failures.push('shorts: ' + registeredShortIndexes.size + ' of ' + expectedShortCount + ' have SEO registration');
      }
      const finalBatch = await store.getDraft(id);
      const finalShorts = (await store.listDrafts()).filter((draft) => draft.parentId === id)
        .sort((left, right) => left.highlightIndex - right.highlightIndex);
      const allOutputIdsPresent = Boolean(finalBatch?.youtubeVideoId) &&
        finalShorts.length === expectedShortCount &&
        finalShorts.every((draft) => Boolean(draft.youtubeVideoId));
      const seoReady = finalBatch?.seoRegistrationStatus === 'registered' &&
        finalShorts.every((draft) => draft.seoRegistrationStatus === 'registered');
      const mediaReady = !batch.autoPublishEligible ||
        finalBatch?.mediaValidation === 'passed' &&
        finalShorts.every((draft) => draft.mediaValidation === 'passed') &&
        (finalBatch.twitchClips || []).length === batch.highlights.length &&
        finalBatch.twitchClips.every((clip) => clip.timestampVerification?.verified === true);
      const shouldAutoPublish = autoPublish && batch.autoPublishEligible === true;
      const localProductionReady = failures.length === 0 &&
        registeredShortIndexes.size === expectedShortCount && allOutputIdsPresent &&
        seoReady && mediaReady && (batch.pipelineVersion < 2 || thumbnailStatus === 'applied');
      let youtubeProcessingReady = false;
      const outputs = [finalBatch, ...finalShorts];
      if (localProductionReady) {
        if (typeof youtube.getVideo !== 'function') {
          const error = new Error('YouTube processing checks are unavailable');
          error.status = 503;
          noteFailure('YouTube processing', error);
        } else {
          const outputChecks = await Promise.all(outputs.map(async (output) => {
            const outputType = output.id === id ? 'video' : 'Short';
            const label = output.id === id ? 'highlight processing'
              : 'Short ' + (output.highlightIndex + 1) + ' processing';
            try {
              const current = await youtube.getVideo(output.youtubeVideoId);
              requireCompletedYouTubeOutput(current, output.youtubeVideoId, outputType);
              if (shouldAutoPublish && !['private', 'public'].includes(current.status?.privacyStatus)) {
                const error = new Error('Output visibility changed before automatic publication');
                error.status = current.status?.privacyStatus === 'unlisted' ? 409 : 425;
                throw error;
              }
              return true;
            } catch (error) {
              noteFailure(label, error, 250);
              return false;
            }
          }));
          youtubeProcessingReady = outputChecks.every(Boolean);
        }
      }
      const productionReady = localProductionReady && youtubeProcessingReady;
      const maxAttemptsAllowed = Number.isSafeInteger(maxAutoAttempts) && maxAutoAttempts > 0 ? maxAutoAttempts : 12;
      const retryDelay = Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attemptCount - 1)));
      if (!productionReady) {
        const canAutoRetry = hasRetryableFailure && !hasPermanentFailure && attemptCount < maxAttemptsAllowed;
        const nextClipAttemptAt = canAutoRetry ? new Date(now() + retryDelay).toISOString() : null;
        const error = failures.slice(0, 8).join('; ') || 'Production checks did not pass';
        for (const short of finalShorts) {
          if (short.publicationStatus !== 'published') {
            await store.updateDraft(short.id, {
              status: 'clip_partial',
              productionState: canAutoRetry ? 'processing' : 'partial',
              productionFailures: failures.length ? failures : [error], error
            });
          }
        }
        await store.updateDraft(id, {
          status: canAutoRetry ? 'clip_retry_wait' : 'clip_partial',
          productionState: canAutoRetry ? 'retry_scheduled' : 'partial',
          productionFailures: failures.length ? failures : [error], error, nextClipAttemptAt,
          processedAt: new Date(now()).toISOString()
        });
      } else if (!shouldAutoPublish) {
        for (const short of finalShorts) {
          if (short.publicationStatus !== 'published') {
            await store.updateDraft(short.id, {
              status: 'awaiting_owner_approval', productionState: 'ready',
              productionFailures: [], error: null
            });
          }
        }
        await store.updateDraft(id, {
          status: 'awaiting_owner_approval', productionState: 'ready',
          publicationStatus: 'pending', productionFailures: [], error: null,
          nextClipAttemptAt: null, processedAt: new Date(now()).toISOString()
        });
        logSuccess(id, finalShorts.length);
      } else {
        await store.updateDraft(id, {
          status: 'clip_retry_wait', productionState: 'publishing',
          publicationStatus: 'publishing', productionFailures: [], error: null,
          nextClipAttemptAt: new Date(now()).toISOString()
        });
        for (const output of outputs) {
          if (output.publicationStatus === 'published') continue;
          const label = output.id === id ? 'highlight publication' : 'Short ' + (output.highlightIndex + 1) + ' publication';
          try {
            if (typeof youtube.getVideo !== 'function' || typeof youtube.publish !== 'function') {
              throw new Error('YouTube publication checks are unavailable');
            }
            const current = await youtube.getVideo(output.youtubeVideoId);
            requireCompletedYouTubeOutput(current, output.youtubeVideoId,
              output.id === id ? 'video' : 'Short');
            const privacyStatus = current.status?.privacyStatus;
            if (privacyStatus === 'private') {
              const published = await youtube.publish(output.youtubeVideoId);
              if (published?.status?.privacyStatus !== 'public') {
                const error = new Error('YouTube did not confirm public visibility');
                error.status = 425;
                throw error;
              }
            } else if (privacyStatus !== 'public') {
              const error = new Error('Output visibility changed before automatic publication');
              error.status = 409;
              throw error;
            }
            const publishedAt = new Date(now()).toISOString();
            await store.updateDraft(output.id, {
              publicationStatus: 'published', publishedAt,
              ...(output.id === id
                ? {}
                : { status: 'published', productionState: 'published' })
            });
          } catch (error) {
            const reason = noteFailure(label, error, 250);
            await store.updateDraft(output.id, {
              publicationStatus: isTransientError(error) ? 'retry' : 'failed',
              publicationError: reason
            });
            break;
          }
        }
        const publishedBatch = await store.getDraft(id);
        const publishedShorts = (await store.listDrafts()).filter((draft) => draft.parentId === id);
        const publishedEverything = publishedBatch.publicationStatus === 'published' &&
          publishedShorts.length === expectedShortCount &&
          publishedShorts.every((draft) => draft.publicationStatus === 'published');
        if (publishedEverything) {
          await store.updateDraft(id, {
            status: 'completed', productionState: 'published',
            publicationStatus: 'published', productionFailures: [], error: null,
            nextClipAttemptAt: null, processedAt: new Date(now()).toISOString()
          });
        } else {
          const canAutoRetry = hasRetryableFailure && !hasPermanentFailure && attemptCount < maxAttemptsAllowed;
          if (!canAutoRetry) {
            for (const short of publishedShorts) {
              if (short.publicationStatus !== 'published') {
                await store.updateDraft(short.id, {
                  status: 'awaiting_owner_approval', productionState: 'ready',
                  productionFailures: failures, error: failures.slice(0, 8).join('; ') || 'Automatic publication stopped'
                });
              }
            }
          }
          await store.updateDraft(id, {
            status: canAutoRetry ? 'clip_retry_wait' : 'awaiting_owner_approval',
            productionState: canAutoRetry ? 'retry_scheduled' : 'ready',
            publicationStatus: canAutoRetry ? 'retry' : 'failed',
            productionFailures: failures, error: failures.slice(0, 8).join('; ') || 'Automatic publication stopped',
            nextClipAttemptAt: canAutoRetry ? new Date(now() + retryDelay).toISOString() : null,
            processedAt: new Date(now()).toISOString()
          });
        }
      }
    } catch (error) {
      const message = cleanText(error.message || 'Highlight production failed', 500);
      const attemptCount = (Number(batch && batch.clipAttemptCount) || 0) + 1;
      const canAutoRetry = isTransientError(error) && attemptCount <
        (Number.isSafeInteger(maxAutoAttempts) && maxAutoAttempts > 0 ? maxAutoAttempts : 12);
      const retryDelay = error.code === 'TWITCH_CLIP_METADATA_PENDING'
        ? 2 * 60 * 1000
        : Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attemptCount - 1)));
      logError(id, error);
      await store.updateDraft(id, {
        status: canAutoRetry ? 'clip_retry_wait' : 'clip_failed',
        productionState: canAutoRetry ? 'retry_scheduled' : 'failed', error: message,
        productionFailures: [message],
        nextClipAttemptAt: canAutoRetry ? new Date(now() + retryDelay).toISOString() : null,
        processedAt: new Date(now()).toISOString()
      }).catch(() => {});
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return processHighlightBatch;
}

module.exports = {
  createBatchQueue, createHighlightProcessor, findDueHighlightRetries,
  findHighlightBatchByVodId, isTransientError, shouldPullForwardTwitchMetadataRetry,
  shouldRequeueUnexpectedTwitchDownloadHost, shouldPullForwardAllowedTwitchDownloadHost,
  shouldRequeueTwitchSegmentDurationFailure,
  waitForVerifiedClipMetadata, requireCompletedYouTubeOutput
};

