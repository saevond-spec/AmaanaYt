'use strict';

function publicationMatches(video, publishAt) {
  const status = video?.status || {};
  if (!publishAt) return status.privacyStatus === 'public';
  const requested = Date.parse(publishAt);
  const actual = Date.parse(status.publishAt || '');
  return status.privacyStatus === 'private' && Number.isFinite(requested) &&
    Number.isFinite(actual) && requested === actual;
}

function finalPatch(publishAt, now) {
  return {
    status: publishAt ? 'scheduled' : 'published',
    publicationStatus: publishAt ? 'scheduled' : 'published',
    publishedAt: publishAt ? null : new Date(now()).toISOString(),
    publishAt: publishAt || null,
    youtubePrivacyStatus: publishAt ? 'private' : 'public',
    youtubeUrl: null,
    publicationError: null
  };
}

async function publishApprovedDraft({ draft, publishAt = null, store, youtube, now = Date.now }) {
  const claim = await store.claimDraftForPublication(draft.id);
  if (!claim) {
    throw Object.assign(new Error('Draft changed or its highlight group was excluded; refresh before approving.'), {
      status: 409
    });
  }
  const patch = finalPatch(publishAt, now);
  patch.youtubeUrl = `https://youtu.be/${draft.youtubeVideoId}`;

  const saveConfirmed = async (video) => {
    if (!publicationMatches(video, publishAt)) {
      throw Object.assign(new Error('YouTube did not confirm the requested visibility or schedule.'), { status: 502 });
    }
    const updated = await store.finishDraftPublicationClaim(draft.id, claim.publicationClaimId, patch);
    if (!updated) {
      const persisted = await store.getDraft(draft.id);
      if (persisted && (persisted.publicationStatus === 'published' || persisted.publicationStatus === 'scheduled')) {
        return { draft: persisted, youtube: video.status };
      }
      throw Object.assign(new Error('YouTube confirmed the change, but the draft claim could not be finalized.'), {
        status: 503
      });
    }
    return { draft: updated, youtube: video.status };
  };

  try {
    const published = await youtube.publish(draft.youtubeVideoId, publishAt);
    return await saveConfirmed(published);
  } catch (error) {
    let current = null;
    try {
      current = await youtube.getVideo(draft.youtubeVideoId);
    } catch (_) {
      // A failed read after an interrupted update leaves the external result unknown.
    }
    if (publicationMatches(current, publishAt)) return await saveConfirmed(current);

    const clearlyNotApplied = current?.status?.privacyStatus === 'private' &&
      (!publishAt || !publicationMatches(current, publishAt));
    if (clearlyNotApplied) {
      await store.finishDraftPublicationClaim(draft.id, claim.publicationClaimId, {
        status: 'awaiting_owner_approval', publicationStatus: 'pending',
        publicationError: String(error.message || 'YouTube update failed').slice(0, 240)
      });
    } else {
      // Do not let an ambiguous timeout be retried or excluded as though it were
      // definitely private; an operator can reconcile it through YouTube status.
      await store.finishDraftPublicationClaim(draft.id, claim.publicationClaimId, {
        status: 'publication_ambiguous', publicationStatus: 'ambiguous',
        publicationError: String(error.message || 'YouTube result could not be confirmed').slice(0, 240)
      });
    }
    throw error;
  }
}

module.exports = { publicationMatches, publishApprovedDraft };
