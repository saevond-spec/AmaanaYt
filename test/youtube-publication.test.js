'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPublishStatus } = require('../src/youtube-publication');

const videoId = 'AbCdEfGhI12';
const privateDraft = {
  id: videoId, etag: 'etag-v1',
  snippet: { channelId: 'UC-saevond' },
  status: { privacyStatus: 'private' }
};

test('publishes only the expected private draft with an ETag', () => {
  assert.deepEqual(buildPublishStatus({
    videoId, current: privateDraft, targetChannelId: 'UC-saevond', now: 1000
  }), { privacyStatus: 'public' });
});

test('scheduled publication remains private and must be a future timestamp', () => {
  assert.deepEqual(buildPublishStatus({
    videoId, current: privateDraft, targetChannelId: 'UC-saevond',
    publishAt: '2030-01-01T12:00:00Z', now: Date.parse('2029-12-31T12:00:00Z')
  }), { privacyStatus: 'private', publishAt: '2030-01-01T12:00:00.000Z' });
  assert.throws(() => buildPublishStatus({
    videoId, current: privateDraft, targetChannelId: 'UC-saevond',
    publishAt: '2000-01-01T00:00:00Z'
  }), (error) => error.status === 400 && /future/.test(error.message));
});

test('rejects existing public or unlisted videos and mismatched channel records', () => {
  assert.throws(() => buildPublishStatus({
    videoId, current: { ...privateDraft, status: { privacyStatus: 'public' } },
    targetChannelId: 'UC-saevond'
  }), (error) => error.status === 409);
  assert.throws(() => buildPublishStatus({
    videoId, current: { ...privateDraft, status: { privacyStatus: 'unlisted' } },
    targetChannelId: 'UC-saevond'
  }), (error) => error.status === 409);
  assert.throws(() => buildPublishStatus({
    videoId, current: privateDraft, targetChannelId: 'UC-someone-else'
  }), (error) => error.status === 403);
});

test('rejects stale or incomplete YouTube video records before any visibility update', () => {
  assert.throws(() => buildPublishStatus({
    videoId, current: { ...privateDraft, etag: '' }, targetChannelId: 'UC-saevond'
  }), (error) => error.status === 409);
  assert.throws(() => buildPublishStatus({
    videoId, current: { ...privateDraft, id: 'OtherVideo01' }, targetChannelId: 'UC-saevond'
  }), (error) => error.status === 409);
  assert.throws(() => buildPublishStatus({
    videoId: 'bad', current: privateDraft, targetChannelId: 'UC-saevond'
  }), (error) => error.status === 400);
});
