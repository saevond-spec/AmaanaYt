'use strict';

const { callYouTubeDataApi, getYouTubeDataApiQuotaBlock } = require('./youtube-quota');

const TIKTOK_VIEW_THRESHOLD = 2000;

function viewSnapshot(video, checkedAt = new Date().toISOString()) {
  const raw = video?.statistics?.viewCount;
  const views = typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
    ? Number(raw) : null;
  const privacy = video?.status?.privacyStatus || null;
  return {
    youtubeViews: views,
    youtubePrivacyStatus: privacy,
    youtubeViewsCheckedAt: checkedAt,
    tiktokEligible: privacy === 'public' && views !== null && views > TIKTOK_VIEW_THRESHOLD
  };
}

function isStreamShort(draft) {
  return draft?.sourceType === 'twitch_highlight_short' && Boolean(draft.youtubeVideoId);
}

function canAutoSend(draft) {
  return isStreamShort(draft) && draft.tiktokAutoSendConsent === true && draft.tiktokEligible === true
    && !draft.tiktokAttemptedAt && !draft.tiktokPublishId && !draft.tiktokStatus;
}

function createShortViewMonitor({ store, youtube, onEligible = async () => {},
  logger = console, now = Date.now }) {
  async function saveSnapshot(draft, video) {
    const snapshot = viewSnapshot(video);
    if (snapshot.tiktokEligible && !draft.tiktokEligibleAt) snapshot.tiktokEligibleAt = snapshot.youtubeViewsCheckedAt;
    const updated = await store.updateDraft(draft.id, snapshot);
    if (canAutoSend(updated)) await onEligible(updated);
    return updated;
  }

  async function readVideoViews(ids) {
    const block = await getYouTubeDataApiQuotaBlock(store, now());
    if (block) return null;
    try {
      return await callYouTubeDataApi(store, () => youtube.getVideoViews(ids), now());
    } catch (error) {
      if (error?.youtubeDataApiQuotaBlock) {
        logger.warn?.('YouTube Short view checks paused until ' +
          new Date(error.youtubeDataApiQuotaBlock.blockedUntil).toISOString() +
          ' after YouTube Data API quota limit');
      }
      throw error;
    }
  }

  async function refreshOne(id) {
    const draft = await store.getDraft(id);
    if (!isStreamShort(draft)) return null;
    const videos = await readVideoViews([draft.youtubeVideoId]);
    if (!videos) return null;
    return saveSnapshot(draft, videos.find((video) => video.id === draft.youtubeVideoId));
  }

  async function refreshAll() {
    const drafts = (await store.listDrafts()).filter((draft) => isStreamShort(draft)
      && !draft.tiktokPublishId && !draft.tiktokAttemptedAt);
    let processed = 0;
    for (let offset = 0; offset < drafts.length; offset += 50) {
      if (await getYouTubeDataApiQuotaBlock(store, now())) return processed;
      const batch = drafts.slice(offset, offset + 50);
      const videos = await readVideoViews(batch.map((draft) => draft.youtubeVideoId));
      if (!videos) return processed;
      const byId = new Map(videos.map((video) => [video.id, video]));
      for (const draft of batch) await saveSnapshot(draft, byId.get(draft.youtubeVideoId));
      processed += batch.length;
    }
    return drafts.length;
  }

  return { refreshOne, refreshAll };
}

module.exports = { TIKTOK_VIEW_THRESHOLD, viewSnapshot, canAutoSend, createShortViewMonitor };
