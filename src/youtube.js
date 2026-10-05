const fs = require('fs');
const { google } = require('googleapis');
const store = require('./store');
const { createYouTubePlaylistClient } = require('./youtube-playlists');
const { ensureCreatorTag, buildCreatorTagUpdate } = require('./channel-tags');
const { summarizeYoutubeSearchPerformance, hasYoutubeAnalyticsReadScopes, youtubeSearchReportQueries } = require('./youtube-search-performance');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
];

async function canApprove() {
  const tokens = await store.getTokens();
  return Boolean(tokens?.scope?.split(/\s+/).includes('https://www.googleapis.com/auth/youtube.force-ssl'));
}

async function hasAnalyticsReadAccess() {
  return hasYoutubeAnalyticsReadScopes(await store.getTokens());
}

async function oauthClient() {
  const redirectUri = new URL('/oauth2/callback', process.env.BASE_URL).toString();
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
  const tokens = await store.getTokens();
  if (tokens) client.setCredentials(tokens);
  client.on('tokens', (fresh) => {
    store.getTokens()
      .then((current) => store.saveTokens({ ...(current || {}), ...fresh }))
      .catch((error) => console.error('Failed to persist refreshed YouTube token:', error.message));
  });
  return client;
}

async function isConnected() {
  const tokens = await store.getTokens();
  return Boolean(tokens?.refresh_token || tokens?.access_token);
}

async function authorizationUrl(state) {
  const client = await oauthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state
  });
}

async function exchangeCode(code) {
  const client = await oauthClient();
  const { tokens } = await client.getToken(code);
  await store.saveTokens(tokens);
  return tokens;
}

async function service() {
  const client = await oauthClient();
  if (!client.credentials?.refresh_token && !client.credentials?.access_token) {
    throw new Error('YouTube is not connected');
  }
  return google.youtube({ version: 'v3', auth: client });
}

const playlistClient = createYouTubePlaylistClient(service);

async function uploadPrivate({ filePath, title, description, tags, madeForKids = false }) {
  const youtube = await service();
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, tags: ensureCreatorTag(tags || [], { trimOverflow: true }), categoryId: '20', defaultLanguage: 'en' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: Boolean(madeForKids) }
    },
    media: { body: fs.createReadStream(filePath) }
  });
  return response.data;
}

async function publish(videoId, publishAt) {
  if (!await canApprove()) throw new Error('Reconnect YouTube in the owner dashboard to grant video approval permission');
  const youtube = await service();
  const status = publishAt
    ? { privacyStatus: 'private', publishAt: new Date(publishAt).toISOString() }
    : { privacyStatus: 'public' };
  const response = await youtube.videos.update({
    part: ['status'],
    requestBody: { id: videoId, status }
  });
  return response.data;
}

async function setThumbnail(videoId, filePath) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
    throw new Error('A valid YouTube video ID is required to set its thumbnail');
  }
  const youtube = await service();
  const response = await youtube.thumbnails.set({
    videoId,
    media: { mimeType: 'image/jpeg', body: fs.createReadStream(filePath) }
  });
  return response.data;
}

async function getVideo(videoId) {
  const youtube = await service();
  const response = await youtube.videos.list({
    part: ['snippet', 'status', 'processingDetails', 'contentDetails'],
    id: [videoId]
  });
  return response.data.items?.[0] || null;
}

async function updateVideoSeo(videoId, video, edit) {
  if (!video.etag) {
    const error = new Error('YouTube did not return a video version; refresh before saving');
    error.status = 409;
    throw error;
  }
  const youtube = await service();
  // A snippet update replaces its mutable fields; keep the category and language.
  const snippet = {
    title: edit.title, description: edit.description, tags: edit.tags,
    categoryId: video.snippet.categoryId
  };
  if (video.snippet.defaultLanguage) snippet.defaultLanguage = video.snippet.defaultLanguage;
  if (video.snippet.defaultAudioLanguage) snippet.defaultAudioLanguage = video.snippet.defaultAudioLanguage;
  const response = await youtube.videos.update({
    part: ['snippet'], requestBody: { id: videoId, snippet }
  }, { headers: { 'If-Match': video.etag } });
  return response.data;
}

async function updateVideoTags(video, channelId) {
  const update = buildCreatorTagUpdate(video, channelId);
  if (!update.changed) return { state: 'already_tagged', tags: update.tags };
  const youtube = await service();
  const response = await youtube.videos.update({
    part: ['snippet'], requestBody: update.requestBody
  }, { headers: { 'If-Match': update.etag } });
  return { state: 'updated', tags: update.tags, video: response.data };
}

async function channelSeo() {
  const youtube = await service();
  const response = await youtube.channels.list({
    part: ['snippet', 'brandingSettings', 'contentDetails'], mine: true
  });
  const channel = response.data.items?.[0];
  if (!channel?.id) throw new Error('The connected YouTube account has no channel');
  return {
    id: channel.id, etag: channel.etag, title: channel.snippet?.title || '',
    description: channel.brandingSettings?.channel?.description ?? channel.snippet?.description ?? '',
    keywords: channel.brandingSettings?.channel?.keywords || '',
    uploads: channel.contentDetails?.relatedPlaylists?.uploads || null,
    brandingChannel: channel.brandingSettings?.channel || {}
  };
}

async function assertTargetChannel(channelId) {
  const handle = process.env.YOUTUBE_CHANNEL_HANDLE || '@saevond';
  const youtube = await service();
  const response = await youtube.channels.list({
    part: ['snippet'], forHandle: handle, fields: 'items(id)'
  });
  if (!response.data.items?.some((channel) => channel.id === channelId)) {
    const error = new Error(`Connected YouTube channel does not match ${handle}`);
    error.status = 403;
    throw error;
  }
}

async function updateChannelSeo(expected, edit) {
  const current = await channelSeo();
  if (current.id !== expected.id || current.description !== expected.description ||
      current.keywords !== expected.keywords) {
    const error = new Error('Channel settings changed; refresh before saving');
    error.status = 409;
    throw error;
  }
  if (!current.etag) {
    const error = new Error('YouTube did not return a channel version; refresh before saving');
    error.status = 409;
    throw error;
  }
  const allowed = ['title', 'description', 'keywords', 'trackingAnalyticsAccountId',
    'unsubscribedTrailer', 'defaultLanguage', 'country'];
  const channel = Object.fromEntries(allowed.filter((name) => current.brandingChannel[name] !== undefined)
    .map((name) => [name, current.brandingChannel[name]]));
  channel.title = current.title;
  channel.description = edit.description;
  channel.keywords = edit.keywords;
  const youtube = await service();
  await youtube.channels.update({
    part: ['brandingSettings'],
    requestBody: { id: current.id, brandingSettings: { channel } }
  }, { headers: { 'If-Match': current.etag } });
  return { id: current.id, title: current.title, ...edit };
}

async function ownedChannel() {
  const youtube = await service();
  const response = await youtube.channels.list({ part: ['snippet', 'contentDetails'], mine: true,
    fields: 'items(id,snippet(title),contentDetails(relatedPlaylists(uploads)))' });
  const channel = response.data.items?.[0];
  if (!channel?.id || !channel.contentDetails?.relatedPlaylists?.uploads) {
    throw new Error('The connected YouTube account has no uploads playlist');
  }
  return { id: channel.id, title: channel.snippet?.title, uploads: channel.contentDetails.relatedPlaylists.uploads };
}

async function uploadsPage(playlistId, pageToken) {
  const youtube = await service();
  const response = await youtube.playlistItems.list({
    part: ['contentDetails'], playlistId, maxResults: 50,
    ...(pageToken ? { pageToken } : {}),
    fields: 'nextPageToken,items(contentDetails(videoId))'
  });
  return { ids: (response.data.items || []).map((item) => item.contentDetails?.videoId).filter(Boolean),
    nextPageToken: response.data.nextPageToken || null };
}

async function videoMetadata(ids) {
  if (!Array.isArray(ids) || ids.length > 50) throw new Error('Request metadata for up to 50 videos');
  if (!ids.length) return [];
  const youtube = await service();
  const response = await youtube.videos.list({ part: ['snippet', 'status', 'contentDetails', 'statistics'], id: ids,
    fields: 'items(id,etag,snippet(title,description,tags,publishedAt,channelId,categoryId,defaultLanguage,defaultAudioLanguage),status(privacyStatus),contentDetails(duration),statistics(viewCount))' });
  return response.data.items || [];
}

async function getVideoViews(videoIds) {
  if (!Array.isArray(videoIds) || !videoIds.length || videoIds.length > 50) {
    throw new Error('Request views for 1–50 YouTube videos at a time');
  }
  const youtube = await service();
  const response = await youtube.videos.list({
    part: ['statistics', 'status'],
    id: videoIds,
    fields: 'items(id,statistics(viewCount),status(privacyStatus))'
  });
  return response.data.items || [];
}

async function googleSearchTraffic(videoId, startDate, endDate) {
  const queries = youtubeSearchReportQueries(videoId, startDate, endDate);
  if (!await hasAnalyticsReadAccess()) {
    const error = new Error('Reconnect YouTube to grant read-only Analytics access');
    error.status = 403;
    throw error;
  }
  const auth = await oauthClient();
  const analytics = google.youtubeAnalytics({ version: 'v2', auth });
  const [traffic, details] = await Promise.all(queries.map((query) => analytics.reports.query(query)));
  return summarizeYoutubeSearchPerformance(traffic.data?.rows || [], details.data?.rows || []);
}

async function listOwnedBroadcasts() {
  const youtube = await service();
  const broadcasts = [];
  for (const broadcastStatus of ['active', 'upcoming']) {
    let pageToken;
    do {
      const response = await youtube.liveBroadcasts.list({
        part: ['snippet', 'status', 'contentDetails', 'monetizationDetails'],
        broadcastStatus, broadcastType: 'all', maxResults: 50,
        ...(pageToken ? { pageToken } : {})
      });
      broadcasts.push(...(response.data.items || []));
      pageToken = response.data.nextPageToken || null;
    } while (pageToken);
  }
  return broadcasts;
}

async function recentGameVideos(game, { now = Date.now() } = {}) {
  const youtube = await service();
  const response = await youtube.search.list({
    part: ['snippet'], type: 'video', q: `${game} gameplay`, order: 'viewCount',
    publishedAfter: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: 10
  });
  const ids = (response.data.items || []).map((item) => item.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await youtube.videos.list({
    part: ['snippet', 'statistics', 'status'], id: ids,
    fields: 'items(id,snippet(title,publishedAt,channelId),statistics(viewCount),status(privacyStatus))'
  });
  const dayMs = 24 * 60 * 60 * 1000;
  return (details.data.items || []).filter((item) => {
    const publishedAtMs = Date.parse(item.snippet?.publishedAt || '');
    const viewCount = Number(item.statistics?.viewCount);
    return item.status?.privacyStatus === 'public' && Number.isFinite(publishedAtMs) &&
      publishedAtMs <= now && Number.isSafeInteger(viewCount) && viewCount >= 0;
  }).map((item) => {
    const publishedAtMs = Date.parse(item.snippet.publishedAt);
    const viewCount = Number(item.statistics.viewCount);
    const ageDays = Math.max(1, (now - publishedAtMs) / dayMs);
    return { id: item.id, title: String(item.snippet.title || '').slice(0, 150),
      channelId: item.snippet.channelId, publishedAt: item.snippet.publishedAt,
      viewCount, estimatedViewsPerDay: Math.round(viewCount / ageDays) };
  }).sort((left, right) => right.estimatedViewsPerDay - left.estimatedViewsPerDay ||
    right.viewCount - left.viewCount);
}

async function enablePublicBroadcastAds(broadcast) {
  if (!broadcast?.etag || broadcast.status?.privacyStatus !== 'public' ||
      broadcast.monetizationDetails?.eligibleForAdsMonetization !== true ||
      !['created', 'ready', 'testing', 'live'].includes(broadcast.status?.lifeCycleStatus) ||
      !broadcast.snippet?.title || !broadcast.snippet?.scheduledStartTime ||
      !broadcast.snippet?.categoryId ||
      typeof broadcast.contentDetails?.monitorStream?.enableMonitorStream !== 'boolean' ||
      !Number.isSafeInteger(broadcast.contentDetails?.monitorStream?.broadcastStreamDelayMs)) {
    throw new Error('Broadcast is not versioned, eligible, public, active, or has incomplete required metadata');
  }
  if (broadcast.monetizationDetails.adsMonetizationStatus === 'on') return broadcast;
  const youtube = await service();
  const schedule = broadcast.monetizationDetails.cuepointSchedule;
  const monetizationDetails = { adsMonetizationStatus: 'on',
    cuepointSchedule: schedule ? {
      enabled: schedule.enabled === true,
      ...(schedule.enabled === true && schedule.ytOptimizedCuepointConfig != null ?
        { ytOptimizedCuepointConfig: schedule.ytOptimizedCuepointConfig } : {}),
      ...(schedule.enabled === true && schedule.creatorCuepointConfig ?
        { creatorCuepointConfig: schedule.creatorCuepointConfig } : {}),
      ...(schedule.enabled === true && schedule.pauseAdsUntil ?
        { pauseAdsUntil: schedule.pauseAdsUntil } : {})
    } : { enabled: false } };
  const snippet = {
    title: broadcast.snippet.title,
    description: broadcast.snippet.description || '',
    categoryId: broadcast.snippet.categoryId,
    scheduledStartTime: broadcast.snippet.scheduledStartTime
  };
  if (broadcast.snippet.scheduledEndTime) snippet.scheduledEndTime = broadcast.snippet.scheduledEndTime;
  const sourceDetails = broadcast.contentDetails;
  const contentDetails = { monitorStream: {
    enableMonitorStream: sourceDetails.monitorStream.enableMonitorStream,
    broadcastStreamDelayMs: sourceDetails.monitorStream.broadcastStreamDelayMs
  } };
  for (const key of ['enableAutoStart', 'enableAutoStop', 'enableClosedCaptions',
    'enableDvr', 'enableEmbed', 'recordFromStart', 'availabilityConfig']) {
    if (sourceDetails[key] != null) contentDetails[key] = sourceDetails[key];
  }
  const response = await youtube.liveBroadcasts.update({
    part: ['snippet', 'contentDetails', 'monetizationDetails'],
    requestBody: {
      id: broadcast.id,
      snippet,
      contentDetails,
      monetizationDetails
    }
  }, { headers: { 'If-Match': broadcast.etag } });
  if (response.data?.monetizationDetails?.adsMonetizationStatus !== 'on') {
    throw new Error('YouTube did not confirm broadcast ads are on');
  }
  return response.data;
}

module.exports = { isConnected, canApprove, hasAnalyticsReadAccess, authorizationUrl, exchangeCode, uploadPrivate, setThumbnail, publish,
  getVideo, updateVideoSeo, updateVideoTags, channelSeo, updateChannelSeo, assertTargetChannel,
  getVideoViews, googleSearchTraffic, ownedChannel, uploadsPage, videoMetadata,
  listOwnedBroadcasts, enablePublicBroadcastAds, recentGameVideos,
  listOwnedPlaylists: playlistClient.listOwnedPlaylists,
  listPlaylistVideoIds: playlistClient.listPlaylistVideoIds,
  createPlaylist: playlistClient.createPlaylist,
  addVideoToPlaylist: playlistClient.addVideoToPlaylist };
