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

function createShortViewMonitor({ store, youtube, onEligible = async () => {} }) {
  async function saveSnapshot(draft, video) {
    const snapshot = viewSnapshot(video);
    if (snapshot.tiktokEligible && !draft.tiktokEligibleAt) snapshot.tiktokEligibleAt = snapshot.youtubeViewsCheckedAt;
    const updated = await store.updateDraft(draft.id, snapshot);
    if (canAutoSend(updated)) await onEligible(updated);
    return updated;
  }

  async function refreshOne(id) {
    const draft = await store.getDraft(id);
    if (!isStreamShort(draft)) return null;
    const videos = await youtube.getVideoViews([draft.youtubeVideoId]);
    return saveSnapshot(draft, videos.find((video) => video.id === draft.youtubeVideoId));
  }

  async function refreshAll() {
    const drafts = (await store.listDrafts()).filter((draft) => isStreamShort(draft)
      && !draft.tiktokPublishId && !draft.tiktokAttemptedAt);
    for (let offset = 0; offset < drafts.length; offset += 50) {
      const batch = drafts.slice(offset, offset + 50);
      const videos = await youtube.getVideoViews(batch.map((draft) => draft.youtubeVideoId));
      const byId = new Map(videos.map((video) => [video.id, video]));
      for (const draft of batch) await saveSnapshot(draft, byId.get(draft.youtubeVideoId));
    }
    return drafts.length;
  }

  return { refreshOne, refreshAll };
}

module.exports = { TIKTOK_VIEW_THRESHOLD, viewSnapshot, canAutoSend, createShortViewMonitor };
