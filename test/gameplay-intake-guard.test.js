'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlaceholderTestTitle,
  isNonGameplayTestClip,
  collectTestVodDrafts,
  hasProtectedPublication
} = require('../src/gameplay-intake-guard');

const parentId = '00000000-0000-4000-8000-000000000001';
const secondBatchId = '00000000-0000-4000-8000-000000000002';
const shortId = '00000000-0000-4000-8000-000000000003';
const clipId = '00000000-0000-4000-8000-000000000004';
const otherId = '00000000-0000-4000-8000-000000000005';

test('recognizes exact placeholder titles without flagging descriptive gaming streams', () => {
  for (const title of ['Test', 'Testing', 'Test Stream', 'stream-test', 'VOD test', 'clip test']) {
    assert.equal(isPlaceholderTestTitle(title), true, title);
  }
  for (const title of ['Testing a new build in Ranked', 'Test your aim | Apex Legends', 'Ranked Test Server']) {
    assert.equal(isPlaceholderTestTitle(title), false, title);
  }
});

test('identifies WzBot placeholder test commands but leaves real stream titles eligible', () => {
  assert.equal(isNonGameplayTestClip({
    streamTitle: 'Test', clipTitle: 'Ranked clutch'
  }), true);
  assert.equal(isNonGameplayTestClip({
    streamTitle: 'Ranked session',
    clipTitle: 'WzBot CLIP | Test (by saevond) | Test | at 18:39'
  }), true);
  assert.equal(isNonGameplayTestClip({
    streamTitle: 'Testing new tactics in ranked',
    clipTitle: 'Ranked clutch | Test the new combo'
  }), false);
});

test('collects only a test VOD parent, its clips, and Shorts from the same batch family', () => {
  const drafts = [
    { id: parentId, sourceType: 'twitch_highlight_batch', vodId: '2903467786', streamTitle: 'Test' },
    { id: secondBatchId, sourceType: 'twitch_highlight_batch', vodId: '2903467786', streamTitle: 'Test' },
    { id: shortId, sourceType: 'twitch_highlight_short', parentId },
    { id: clipId, sourceType: 'twitch_vod', discoverySource: 'twitch_community_clip', vodId: '2903467786' },
    { id: otherId, sourceType: 'twitch_vod', discoverySource: 'twitch_community_clip', vodId: '2905056660' }
  ];

  assert.deepEqual(collectTestVodDrafts(drafts, parentId).map((draft) => draft.id).sort(),
    [parentId, secondBatchId, shortId, clipId].sort());
  assert.deepEqual(collectTestVodDrafts(drafts, otherId), []);
  assert.deepEqual(collectTestVodDrafts([
    { id: otherId, sourceType: 'twitch_highlight_batch', vodId: '999', streamTitle: 'Ranked session' }
  ], otherId), []);
});

test('blocks exclusion of public, published, or scheduled videos', () => {
  assert.equal(hasProtectedPublication([{ status: 'published' }]), true);
  assert.equal(hasProtectedPublication([{ youtubePrivacyStatus: 'public' }]), true);
  assert.equal(hasProtectedPublication([{ publicationStatus: 'scheduled' }]), true);
  assert.equal(hasProtectedPublication([{ status: 'awaiting_owner_approval', youtubePrivacyStatus: 'private' }]), false);
});
