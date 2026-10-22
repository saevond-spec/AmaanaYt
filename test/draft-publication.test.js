'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicationMatches, publishApprovedDraft } = require('../src/draft-publication');
const { hasProtectedPublication } = require('../src/gameplay-intake-guard');

const draft = { id: 'draft-1', youtubeVideoId: 'abcdefghijk', status: 'awaiting_owner_approval' };

function harness(options = {}) {
  const state = { ...draft, publicationStatus: 'pending', publicationClaimId: null };
  const events = [];
  const store = {
    async claimDraftForPublication(id) {
      events.push('claim');
      if (options.claimDenied || state.status !== 'awaiting_owner_approval') return null;
      state.status = 'publication_in_progress';
      state.publicationStatus = 'publishing';
      state.publicationClaimId = 'claim-1';
      return { ...state };
    },
    async finishDraftPublicationClaim(id, claimId, patch) {
      events.push('finish:' + patch.publicationStatus);
      if (state.publicationClaimId !== claimId) return null;
      Object.assign(state, patch);
      if (patch.publicationStatus !== 'ambiguous') state.publicationClaimId = null;
      return { ...state };
    },
    async getDraft() { return { ...state }; }
  };
  const youtube = {
    async publish() {
      events.push('youtube.publish');
      if (options.publishError) throw new Error(options.publishError);
      return options.publishResponse || { status: { privacyStatus: 'public' } };
    },
    async getVideo() {
      events.push('youtube.getVideo');
      if (options.readError) throw new Error('status unavailable');
      return options.currentVideo || { status: { privacyStatus: 'private' } };
    }
  };
  return { state, events, store, youtube };
}

test('manual publication is refused if exclusion wins the database claim first', async () => {
  const h = harness({ claimDenied: true });
  await assert.rejects(publishApprovedDraft({ draft, store: h.store, youtube: h.youtube }),
    (error) => error.status === 409);
  assert.deepEqual(h.events, ['claim']);
});

test('manual publication is recorded only after YouTube confirms public visibility', async () => {
  const h = harness();
  const result = await publishApprovedDraft({ draft, store: h.store, youtube: h.youtube,
    now: () => Date.parse('2026-10-22T12:00:00Z') });
  assert.equal(result.draft.publicationStatus, 'published');
  assert.equal(result.draft.youtubePrivacyStatus, 'public');
  assert.deepEqual(h.events, ['claim', 'youtube.publish', 'finish:published']);
  assert.equal(hasProtectedPublication([result.draft]), true);
});

test('scheduled publication requires private visibility and the exact requested publish time', async () => {
  const publishAt = '2026-11-01T15:30:00.000Z';
  const h = harness({ publishResponse: { status: { privacyStatus: 'private', publishAt } } });
  const result = await publishApprovedDraft({ draft, publishAt, store: h.store, youtube: h.youtube });
  assert.equal(result.draft.publicationStatus, 'scheduled');
  assert.equal(result.draft.youtubePrivacyStatus, 'private');
  assert.equal(publicationMatches({ status: { privacyStatus: 'public' } }, publishAt), false);
  assert.equal(hasProtectedPublication([result.draft]), true);
});

test('a definite non-public result releases the claim so owner approval can retry', async () => {
  const h = harness({ publishError: 'permission denied' });
  await assert.rejects(publishApprovedDraft({ draft, store: h.store, youtube: h.youtube }),
    /permission denied/);
  assert.equal(h.state.status, 'awaiting_owner_approval');
  assert.equal(h.state.publicationStatus, 'pending');
  assert.equal(h.state.publicationClaimId, null);
});

test('an unobservable YouTube result stays protected as ambiguous instead of being retried', async () => {
  const h = harness({ publishError: 'connection reset', readError: true });
  await assert.rejects(publishApprovedDraft({ draft, store: h.store, youtube: h.youtube }),
    /connection reset/);
  assert.equal(h.state.publicationStatus, 'ambiguous');
  assert.equal(h.state.publicationClaimId, 'claim-1');
  assert.equal(hasProtectedPublication([h.state]), true);
});

test('a publish timeout reconciles as success when YouTube already reports public', async () => {
  const h = harness({ publishError: 'socket timed out', currentVideo: { status: { privacyStatus: 'public' } } });
  const result = await publishApprovedDraft({ draft, store: h.store, youtube: h.youtube });
  assert.equal(result.draft.publicationStatus, 'published');
  assert.ok(h.events.includes('youtube.getVideo'));
});
