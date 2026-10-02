const { descriptionChapters } = require('./seo-package');

function problem(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sameTags(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

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
  if (video.snippet.title !== item.source.title ||
      (video.snippet.description || '') !== (item.source.description || '') ||
      !sameTags(video.snippet.tags, item.source.tags)) {
    throw problem('YouTube metadata changed since the package was generated', 409);
  }
  if (!video.snippet.categoryId) throw problem('YouTube did not return the video category', 409);
}

function automaticVideoEdit(item) {
  const source = item.source || {};
  const pkg = item.package;
  if (source.privacyStatus !== 'public') throw problem('Only existing public videos can be updated');
  if (!pkg || !['ready', 'needs_review'].includes(item.status)) throw problem('No generated SEO package');
  if (!item.analysis && !item.context?.takeaways?.trim()) {
    throw problem('Video analysis or owner supplied video context is required for automatic publishing');
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
  const tags = [];
  const originalTags = prior && sameTags(source.tags, prior.tags) ? prior.originalTags : source.tags;
  for (const tag of [...(originalTags || []), ...(pkg.tags || [])]) {
    if (typeof tag !== 'string' || !tag.trim() || tags.some((part) => part.toLowerCase() === tag.trim().toLowerCase())) continue;
    if ([...tags, tag.trim()].join(',').length > 450 || tags.length >= 30) break;
    tags.push(tag.trim());
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

function createSeoPublisher({ store, youtube, logger = console }) {
  const configuredLimit = Number(process.env.SEO_AUTO_DAILY_LIMIT);
  const dailyLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 50;
  async function publishVideo(videoId) {
    const item = await store.getSeoVideo(videoId);
    if (!item || item.source?.privacyStatus !== 'public' || !item.package) return;
    const generation = new Date(item.generatedAt).toISOString();
    if (item.autoResult?.packageGeneratedAt === generation && item.autoResult.state !== 'retry') return;
    let result;
    try {
      const edit = automaticVideoEdit(item);
      const [channel, state, video] = await Promise.all([
        youtube.ownedChannel(), store.getSeoSyncState(), youtube.getVideo(videoId)
      ]);
      if (state.channelId !== channel.id) throw problem('Connected channel differs from the SEO catalog', 409);
      await youtube.assertTargetChannel(channel.id);
      if (video?.status?.privacyStatus !== 'public') throw problem('Video is no longer public');
      if (video.snippet?.liveBroadcastContent && video.snippet.liveBroadcastContent !== 'none') {
        throw problem('Livestream has not ended; SEO will retry later', 425);
      }
      assertVideoMatchesCatalog(video, channel.id, item);
      if (typeof store.seoUpdatesToday === 'function' && await store.seoUpdatesToday() >= dailyLimit) {
        throw problem('Daily automatic SEO update budget reached', 429);
      }
      await youtube.updateVideoSeo(videoId, video, edit);
      const prior = item.applied;
      const originalDescription = prior && item.source.description === prior.description
        ? prior.originalDescription : item.source.description;
      const originalTags = prior && sameTags(item.source.tags, prior.tags)
        ? prior.originalTags : item.source.tags;
      const applied = { ...edit, originalDescription, originalTags, at: new Date().toISOString(), packageGeneratedAt: generation,
        privacyStatus: 'public' };
      await store.markSeoApplied(videoId, applied);
      await store.upsertSeoVideo(videoId, { ...item.source, ...edit });
      result = { state: 'applied' };
      logger.info?.(`SEO metadata applied to public video ${videoId}`);
    } catch (error) {
      const code = Number(error.status || error.code);
      result = { state: [401, 403, 408, 425, 429, 500, 502, 503, 504].includes(code) ? 'retry' : 'skipped',
        reason: String(error.message).slice(0, 300) };
      logger.warn?.(`SEO auto publish ${videoId}: ${result.reason}`);
    }
    await store.markSeoAutoResult(videoId, { ...result, at: new Date().toISOString(),
      packageGeneratedAt: generation });
    return result;
  }

  async function publishPending(limit = 20) {
    const candidates = await store.listSeoAutoCandidates(limit);
    logger.info?.(`SEO public publish candidates: ${candidates.length}`);
    for (const candidate of candidates) await publishVideo(candidate.videoId);
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
      logger.info?.(`SEO channel keywords updated for ${channel.id}`);
    } else {
      logger.info?.(`SEO channel unchanged for ${channel.id}: no new grounded keywords`);
    }
  }

  return { publishVideo, publishPending, updateChannel };
}

module.exports = { problem, auditVideo, assertVideoMatchesCatalog, automaticVideoEdit,
  channelSuggestions, channelEdit, createSeoPublisher };
