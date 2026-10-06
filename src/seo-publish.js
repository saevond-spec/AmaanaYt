const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { descriptionChapters } = require('./seo-package');
const { createThumbnailFromImage, thumbnailHeadline } = require('./video');
const { rateThumbnailBriefs } = require('./thumbnail-rating');
const { ensureCreatorTag, youtubeTagCharacters } = require('./channel-tags');
const { findMetadataConflicts } = require('./metadata-uniqueness');

function problem(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function retryablePublishError(error) {
  const code = Number(error.status || error.response?.status || error.code);
  if ([401, 408, 425, 429, 500, 502, 503, 504].includes(code)) return true;
  if (code !== 403) return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(error.code);
  const apiError = error.response?.data?.error || {};
  const reasons = [apiError.status, apiError.message, ...(apiError.errors || []).map((entry) => entry.reason),
    error.message].filter(Boolean).join(' ').toLowerCase();
  return ['quotaexceeded', 'ratelimitexceeded', 'userratelimitexceeded', 'backenderror']
    .some((reason) => reasons.includes(reason));
}

function sameTags(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

const ALLOWED_VIDEO_PRIVACY_STATUSES = new Set(['public']);

function auditVideo(item) {
  const source = item.source || {};
  const keyword = item.package?.primaryKeyword || item.context?.primaryKeyword || '';
  const findings = [];
  if (!source.title?.trim()) findings.push('The video has no title.');
  if (source.title?.length > 70) findings.push('The title is long; review how it appears in search.');
  if ((source.description || '').trim().length < 100) findings.push('The description gives little context about the video.');
  if (!source.tags?.length) findings.push('No relevant video tags are set.');
  if (keyword && !source.title?.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) {
    findings.push('The suggested primary keyword is absent from the current title.');
  }
  if (keyword && !source.description?.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) {
    findings.push('The suggested primary keyword is absent from the current description.');
  }
  if (/\[(?:add|insert|replace|your|tbd|todo)[^\]]*\]/i.test(source.description || '')) {
    findings.push('The public description appears to contain an unfinished placeholder.');
  }
  if (source.durationSeconds >= 60 && !descriptionChapters(source.description, source.durationSeconds).length) {
    findings.push('No verified chapter markers were detected in the current description.');
  }
  if (item.package?.missingEvidence?.length) findings.push('The SEO package has limited evidence.');
  return findings;
}

function assertVideoMatchesCatalog(video, channelId, item) {
  if (!video || video.snippet?.channelId !== channelId || item.source?.channelId !== channelId) {
    throw problem('This video is not on the connected channel', 403);
  }
  const privacyStatus = item.source?.privacyStatus;
  if (!ALLOWED_VIDEO_PRIVACY_STATUSES.has(privacyStatus)) {
    throw problem('This video has an unsupported privacy status', 403);
  }
  if (video.status?.privacyStatus !== privacyStatus) {
    throw problem('Video visibility changed since the catalog scan', 409);
  }
  if (video.snippet.title !== item.source.title ||
      (video.snippet.description || '') !== (item.source.description || '') ||
      !sameTags(video.snippet.tags, item.source.tags)) {
    throw problem('YouTube metadata changed since the package was generated', 409);
  }
  if (!video.snippet.categoryId) throw problem('YouTube did not return the video category', 409);
}

function metadataOwnerReviewReason(item) {
  const pkg = item?.package || {};
  const warnings = Array.isArray(pkg.missingEvidence) ? pkg.missingEvidence : [];
  if (pkg.metadataConflicts?.length || warnings.some((warning) =>
    /duplicate titles|closely matches another public video/i.test(String(warning)))) {
    return 'Generated title or description closely matches existing channel metadata; owner review is required';
  }
  if (pkg.metadataCatalogComplete === false || warnings.some((warning) =>
    /public metadata catalog is incomplete/i.test(String(warning)))) {
    return 'Public video metadata catalog is incomplete; owner review is required before automatic edits';
  }
  return null;
}

function automaticVideoEdit(item) {
  const source = item.source || {};
  const pkg = item.package;
  if (!ALLOWED_VIDEO_PRIVACY_STATUSES.has(source.privacyStatus)) {
    throw problem('Only public videos can be automatically updated');
  }
  if (!pkg || !['ready', 'needs_review'].includes(item.status)) throw problem('No generated SEO package');
  const ownerReviewReason = metadataOwnerReviewReason(item);
  if (ownerReviewReason) throw problem(ownerReviewReason);
  const hasOwnerContext = Boolean(item.context?.takeaways?.trim());
  const hasVideoAnalysis = Boolean(item.analysis);
  const hasDescriptionEvidence = String(source.description || '').trim().length >= 100;
  if (!hasVideoAnalysis && !hasOwnerContext && !hasDescriptionEvidence) {
    throw problem('Video analysis, owner takeaways, or a description of at least 100 characters is required');
  }
  if (pkg.missingEvidence?.some((warning) => /script or key takeaways/i.test(warning))) {
    throw problem('The package has insufficient evidence for its claims');
  }
  const title = (pkg.titles?.hybrid?.[0] || pkg.titles?.search?.[0] || '').trim();
  if (!title || title.length > 100 || /[\r\n]/.test(title)) throw problem('Invalid generated title');
  const summary = [pkg.hook, ...(pkg.paragraphs || [])].filter(Boolean).join('\n\n').trim();
  const prior = item.applied;
  const original = (prior && source.description === prior.description
    ? prior.originalDescription : source.description || '').trim();
  const hashtags = (pkg.hashtags || []).join(' ');
  if (/\[(?:add|insert|replace|your|tbd|todo)[^\]]*\]/i.test(summary) || !summary) {
    throw problem('Generated copy contains unfinished placeholders');
  }
  // Keep existing links, disclosures, and verified timestamps verbatim.
  let description = [summary, original, hashtags].filter(Boolean).join('\n\n');
  // A full existing description can still receive a better title and tags.
  // Keep its text intact instead of dropping links or disclosures to make room.
  if (Buffer.byteLength(description, 'utf8') > 5000) description = original;
  if (!description || Buffer.byteLength(description, 'utf8') > 5000) {
    throw problem('Description exceeds 5,000 bytes');
  }
  const originalTags = prior && sameTags(source.tags, prior.tags) ? prior.originalTags : source.tags;
  const packageTags = ensureCreatorTag(pkg.tags || [], { maxCharacters: 450, maxTags: 8, trimOverflow: true });
  const tags = [];
  for (const tag of [...packageTags, ...(originalTags || [])]) {
    if (typeof tag !== 'string' || !tag.trim()) continue;
    const value = tag.trim();
    if (tags.some((part) => part.toLowerCase() === value.toLowerCase())) continue;
    if (tags.length >= 30) break;
    if (youtubeTagCharacters([...tags, value]) > 450) continue;
    tags.push(value);
  }
  return { title, description, tags };
}

function channelSuggestions(videos) {
  const counts = new Map();
  for (const video of videos) {
    const keyword = video.package?.primaryKeyword?.trim();
    if (!keyword || keyword.length > 60 || video.source?.privacyStatus !== 'public' ||
        !video.analysis && !video.context?.takeaways?.trim()) continue;
    const key = keyword.toLocaleLowerCase();
    const prior = counts.get(key);
    counts.set(key, { keyword, count: (prior?.count || 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, 12).map((entry) => entry.keyword);
}

function channelEdit(current, suggestions) {
  if (!suggestions.length) return null;
  const currentKeywords = current.keywords.trim();
  const additions = [];
  for (const phrase of suggestions) {
    if (currentKeywords.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())) continue;
    const clean = phrase.replaceAll('"', '').trim();
    if (!clean) continue;
    const candidate = /\s/.test(clean) ? `"${clean}"` : clean;
    if ([currentKeywords, ...additions, candidate].filter(Boolean).join(' ').length > 500) break;
    additions.push(candidate);
  }
  const keywords = [currentKeywords, ...additions].filter(Boolean).join(' ');
  const description = current.description.trim() ||
    `${current.title} shares gaming videos featuring ${suggestions.slice(0, 3).join(', ')}.`;
  if (description.length > 1000 || (description === current.description && keywords === current.keywords)) return null;
  return { description, keywords };
}

function safeHeadline(value) {
  const words = String(value || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && words.join(' ').length <= 22 &&
    words.every((word) => /^[A-Z0-9]+$/.test(word));
}

function thumbnailChoiceFor(item) {
  const source = item.source || {};
  const result = rateThumbnailBriefs(item.package?.thumbnails || [], {
    source, context: item.context, analysis: item.analysis
  });
  const selected = result.selected;
  if (selected) {
    const brief = item.package.thumbnails[selected.index];
    if (safeHeadline(brief?.overlay)) {
      return {
        headline: brief.overlay.trim().toUpperCase(),
        selection: {
          option: selected.index + 1,
          score: selected.score,
          grade: selected.grade,
          method: result.method,
          reasons: selected.reasons
        }
      };
    }
  }

  if (!/[A-Za-z0-9]/.test(String(source.title || ''))) return null;
  const fromTitle = thumbnailHeadline(source.title);
  if (!safeHeadline(fromTitle) || fromTitle === 'SAEVOND HIGHLIGHT') return null;
  return {
    headline: fromTitle,
    selection: {
      option: null,
      score: null,
      grade: null,
      method: 'title_fallback',
      reasons: ['No grounded thumbnail concept met the readability and selection threshold; text was derived from the existing video title.']
    }
  };
}

const YOUTUBE_THUMBNAIL_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com']);
const YOUTUBE_THUMBNAIL_DIMENSIONS = {
  default: { width: 120, height: 90 },
  medium: { width: 320, height: 180 },
  high: { width: 480, height: 360 },
  standard: { width: 640, height: 480 },
  maxres: { width: 1280, height: 720 },
  fhd: { width: 1920, height: 1080 },
  qhd: { width: 2560, height: 1440 },
  uhd: { width: 3840, height: 2160 }
};

async function youtubeThumbnailImage(video, fetchImpl = fetch) {
  const candidates = Object.entries(video?.snippet?.thumbnails || {}).map(([variant, image]) => {
    const fallback = YOUTUBE_THUMBNAIL_DIMENSIONS[variant] || {};
    return { ...image, width: Number(image?.width) || fallback.width,
      height: Number(image?.height) || fallback.height };
  }).filter((image) => image?.url && Number(image.width) >= 480 && Number(image.height) >= 270)
    .sort((left, right) => Number(right.width) * Number(right.height) - Number(left.width) * Number(left.height));
  if (!candidates.length) throw problem('YouTube did not provide a usable thumbnail image', 422);

  let lastError = null;
  for (const image of candidates) {
    try {
      const url = new URL(image.url);
      if (url.protocol !== 'https:' || !YOUTUBE_THUMBNAIL_HOSTS.has(url.hostname)) {
        throw problem('Thumbnail URL was not served by YouTube', 400);
      }
      const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        lastError = Object.assign(new Error('YouTube thumbnail download returned HTTP ' + response.status), { status: response.status });
        continue;
      }
      const finalUrl = response.url ? new URL(response.url) : url;
      if (finalUrl.protocol !== 'https:' || !YOUTUBE_THUMBNAIL_HOSTS.has(finalUrl.hostname)) {
        throw problem('Thumbnail redirect left YouTube image hosting', 400);
      }
      const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
        throw problem('YouTube thumbnail did not return a supported image', 422);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
        throw problem('YouTube thumbnail image is empty or oversized', 413);
      }
      const extension = contentType === 'image/png' ? '.png' :
        contentType === 'image/webp' ? '.webp' : '.jpg';
      return { buffer, extension, width: Number(image.width), height: Number(image.height) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || problem('YouTube thumbnail image could not be downloaded', 502);
}

async function uploadSeoThumbnail(videoId, video, item, { youtube, fetchImpl, renderThumbnail, selection }) {
  const choice = selection || thumbnailChoiceFor(item);
  const headline = choice?.headline;
  if (!headline) return { state: 'skipped', reason: 'No supported, evidence-grounded thumbnail text is available' };
  if (typeof youtube.setThumbnail !== 'function') {
    return { state: 'skipped', reason: 'YouTube thumbnail upload is unavailable' };
  }
  const image = await youtubeThumbnailImage(video, fetchImpl);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amaana-seo-thumbnail-'));
  const inputPath = path.join(directory, 'source' + image.extension);
  const outputPath = path.join(directory, 'thumbnail.jpg');
  try {
    await fs.writeFile(inputPath, image.buffer);
    await renderThumbnail(inputPath, outputPath, { headline,
      sourceWidth: image.width, sourceHeight: image.height });
    const output = await fs.readFile(outputPath);
    if (output.length < 4 || output[0] !== 0xff || output[1] !== 0xd8) {
      throw new Error('Thumbnail renderer did not produce a JPEG');
    }
    if (output.length > 50 * 1024 * 1024) throw problem('Generated thumbnail exceeds YouTube’s upload limit', 413);
    await youtube.setThumbnail(videoId, outputPath);
    return { state: 'applied', headline, selection: choice.selection };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function createSeoPublisher({ store, youtube, logger = console, fetchImpl = fetch,
  renderThumbnail = createThumbnailFromImage }) {
  const configuredLimit = Number(process.env.SEO_AUTO_DAILY_LIMIT);
  const dailyLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 50;
  const legacyContextBlock = 'Video analysis or owner supplied video context is required for automatic publishing';

  async function recordResult(videoId, generation, metadata, thumbnail, prior = {}) {
    const at = new Date().toISOString();
    const result = {
      ...(metadata || { state: 'skipped', reason: 'Metadata update was not eligible' }),
      at,
      packageGeneratedAt: generation
    };
    if (thumbnail) {
      result.thumbnailState = thumbnail.state;
      if (thumbnail.reason) result.thumbnailReason = thumbnail.reason;
      if (thumbnail.headline) result.thumbnailHeadline = thumbnail.headline;
      if (thumbnail.selection) result.thumbnailSelection = thumbnail.selection;
      if (thumbnail.state === 'applied') result.thumbnailAt = at;
      else if (prior.thumbnailAt) result.thumbnailAt = prior.thumbnailAt;
    } else if (prior.thumbnailState) {
      result.thumbnailState = prior.thumbnailState;
      if (prior.thumbnailReason) result.thumbnailReason = prior.thumbnailReason;
      if (prior.thumbnailHeadline) result.thumbnailHeadline = prior.thumbnailHeadline;
      if (prior.thumbnailSelection) result.thumbnailSelection = prior.thumbnailSelection;
      if (prior.thumbnailAt) result.thumbnailAt = prior.thumbnailAt;
    }
    await store.markSeoAutoResult(videoId, result);
    return result;
  }

  async function publishVideo(videoId, currentPublicMetadata = null) {
    let item = await store.getSeoVideo(videoId);
    if (!item || !item.package) return;
    if (Array.isArray(currentPublicMetadata)) {
      const title = item.package.titles?.hybrid?.[0] || item.package.titles?.search?.[0] || '';
      const conflicts = findMetadataConflicts({
        title, description: item.package.description || '', videoId, peers: currentPublicMetadata
      });
      const known = new Set((item.package.metadataConflicts || []).map((conflict) =>
        String(conflict.kind) + ':' + String(conflict.videoId)));
      const merged = [...(item.package.metadataConflicts || [])];
      for (const conflict of conflicts) {
        const key = String(conflict.kind) + ':' + String(conflict.videoId);
        if (!known.has(key)) {
          known.add(key);
          merged.push(conflict);
        }
      }
      if (merged.length) item = { ...item, package: { ...item.package, metadataConflicts: merged } };
    }
    const privacyStatus = item.source?.privacyStatus;
    if (!ALLOWED_VIDEO_PRIVACY_STATUSES.has(privacyStatus)) return;

    const generation = new Date(item.generatedAt).toISOString();
    const prior = item.autoResult || {};
    const sameGeneration = prior.packageGeneratedAt === generation;
    const legacyContextSkip = sameGeneration && prior.state === 'skipped' && prior.reason === legacyContextBlock;
    const metadataDone = sameGeneration && prior.state !== 'retry' && !legacyContextSkip;
    const thumbnailDone = sameGeneration && ['applied', 'skipped'].includes(prior.thumbnailState);
    if (metadataDone && thumbnailDone) return prior;

    const ownerReviewReason = metadataOwnerReviewReason(item);
    if (ownerReviewReason) {
      return recordResult(videoId, generation,
        { state: 'skipped', reason: ownerReviewReason },
        { state: 'skipped', reason: 'All automatic SEO edits are blocked while metadata is in owner review' },
        prior);
    }

    let metadata = metadataDone ? { state: prior.state, reason: prior.reason } : null;
    let edit = null;
    if (!metadataDone) {
      try {
        edit = automaticVideoEdit(item);
      } catch (error) {
        metadata = { state: 'skipped', reason: String(error.message).slice(0, 300) };
      }
    }

    let thumbnail = thumbnailDone
      ? { state: prior.thumbnailState, reason: prior.thumbnailReason, headline: prior.thumbnailHeadline,
        selection: prior.thumbnailSelection }
      : null;
    let selectedThumbnail = null;
    let headline = null;
    if (!thumbnailDone) {
      selectedThumbnail = thumbnailChoiceFor(item);
      headline = selectedThumbnail?.headline || null;
      if (!headline) thumbnail = { state: 'skipped',
        reason: 'No supported, evidence-grounded thumbnail text is available' };
      else if (typeof youtube.setThumbnail !== 'function') thumbnail = { state: 'skipped',
        reason: 'YouTube thumbnail upload is unavailable', selection: selectedThumbnail.selection };
    }
    const metadataWritePending = Boolean(edit);
    const thumbnailWritePending = Boolean(headline && !thumbnailDone);
    if (!metadataWritePending && !thumbnailWritePending) {
      return recordResult(videoId, generation, metadata, thumbnail, prior);
    }

    let channel;
    let video;
    try {
      const values = await Promise.all([youtube.ownedChannel(), store.getSeoSyncState(), youtube.getVideo(videoId)]);
      channel = values[0];
      const state = values[1];
      video = values[2];
      if (state.channelId !== channel.id) throw problem('Connected channel differs from the SEO catalog', 409);
      await youtube.assertTargetChannel(channel.id);
      if (video?.status?.privacyStatus !== privacyStatus) {
        throw problem('Video visibility changed since the catalog scan', 409);
      }
      if (video.snippet?.liveBroadcastContent && video.snippet.liveBroadcastContent !== 'none') {
        throw problem('Livestream has not ended; SEO will retry later', 425);
      }
      assertVideoMatchesCatalog(video, channel.id, item);
    } catch (error) {
      const retry = retryablePublishError(error);
      if (metadataWritePending) metadata = { state: retry ? 'retry' : 'skipped',
        reason: String(error.message).slice(0, 300) };
      if (thumbnailWritePending) thumbnail = { state: retry ? 'retry' : 'skipped',
        reason: String(error.message).slice(0, 300) };
      logger.warn?.('SEO auto publish ' + videoId + ': ' + String(error.message).slice(0, 300));
      return recordResult(videoId, generation, metadata, thumbnail, prior);
    }

    if (typeof store.seoUpdatesToday === 'function' &&
        await store.seoUpdatesToday() >= dailyLimit) {
      const reason = 'Daily automatic metadata and thumbnail update budget reached';
      logger.info?.('SEO update budget reached; remaining candidates will wait until the UTC day resets');
      return { state: 'deferred', reason, deferred: true };
    }

    if (edit) {
      try {
        await youtube.updateVideoSeo(videoId, video, edit);
        const oldApplied = item.applied;
        const originalDescription = oldApplied && item.source.description === oldApplied.description
          ? oldApplied.originalDescription : item.source.description;
        const originalTags = oldApplied && sameTags(item.source.tags, oldApplied.tags)
          ? oldApplied.originalTags : item.source.tags;
        const applied = { ...edit, originalDescription, originalTags, at: new Date().toISOString(),
          packageGeneratedAt: generation, privacyStatus };
        await store.markSeoApplied(videoId, applied);
        await store.upsertSeoVideo(videoId, { ...item.source, ...edit });
        video.snippet = { ...video.snippet, ...edit };
        metadata = { state: 'applied' };
        logger.info?.('SEO metadata applied to public video ' + videoId);
      } catch (error) {
        const retry = retryablePublishError(error);
        metadata = { state: retry ? 'retry' : 'skipped', reason: String(error.message).slice(0, 300) };
        if (thumbnailWritePending) thumbnail = { state: retry ? 'retry' : 'skipped',
          reason: 'Thumbnail waits for metadata write: ' + String(error.message).slice(0, 220) };
        logger.warn?.('SEO auto publish ' + videoId + ': ' + metadata.reason);
      }
    }

    if (thumbnailWritePending && metadata?.state !== 'retry') {
      try {
        const result = await uploadSeoThumbnail(videoId, video, item, {
          youtube, fetchImpl, renderThumbnail, selection: selectedThumbnail
        });
        thumbnail = result;
        if (result.state === 'applied') logger.info?.('SEO thumbnail applied to public video ' + videoId);
      } catch (error) {
        const retry = retryablePublishError(error);
        thumbnail = { state: retry ? 'retry' : 'skipped', reason: String(error.message).slice(0, 300) };
        logger.warn?.('SEO thumbnail ' + videoId + ': ' + thumbnail.reason);
      }
    }

    return recordResult(videoId, generation, metadata, thumbnail, prior);
  }

  async function publishPending(limit = 20, currentPublicMetadata = null) {
    const candidates = await store.listSeoAutoCandidates(limit);
    logger.info?.('SEO metadata and thumbnail candidates: ' + candidates.length);
    for (const candidate of candidates) {
      const result = await publishVideo(candidate.videoId, currentPublicMetadata);
      if (result?.deferred) break;
    }
  }

  async function updateChannel() {
    const [channel, state, videos] = await Promise.all([
      youtube.channelSeo(), store.getSeoSyncState(),
      typeof store.listSeoChannelCandidates === 'function'
        ? store.listSeoChannelCandidates(100) : store.listSeoVideos(100)
    ]);
    if (state.channelId !== channel.id) return;
    await youtube.assertTargetChannel(channel.id);
    const edit = channelEdit(channel, channelSuggestions(
      videos.filter((video) => video.source?.channelId === channel.id)));
    if (edit) {
      await youtube.updateChannelSeo(channel, edit);
      logger.info?.('SEO channel keywords updated for ' + channel.id);
    } else {
      logger.info?.('SEO channel unchanged for ' + channel.id + ': no new grounded keywords');
    }
  }

  return { publishVideo, publishPending, updateChannel };
}

module.exports = { problem, auditVideo, assertVideoMatchesCatalog, automaticVideoEdit,
  channelSuggestions, channelEdit, retryablePublishError, createSeoPublisher };
