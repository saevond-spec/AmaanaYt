'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureCreatorTag, youtubeTagCharacters, buildCreatorTagUpdate } = require('../src/channel-tags');

test('adds the exact handle once and upgrades the legacy plain creator tag', () => {
  assert.deepEqual(ensureCreatorTag(['ARC Raiders', 'Saevond', 'gaming']),
    ['ARC Raiders', '@saevond', 'gaming']);
  assert.deepEqual(ensureCreatorTag(['@Saevond', 'ARC Raiders']),
    ['@saevond', 'ARC Raiders']);
  assert.deepEqual(ensureCreatorTag(['@SAEVOND', 'ARC Raiders', 'Saevond', '@saevond']),
    ['@saevond', 'ARC Raiders']);
});

test('counts YouTube quote overhead for multiword tags and preserves focused tags at the 500-character cap', () => {
  assert.equal(youtubeTagCharacters(['example phrase']), 16);
  const tags = ensureCreatorTag(['Focused Game', 'x'.repeat(490), 'generic'], { trimOverflow: true });
  assert.equal(tags[0], 'Focused Game');
  assert.ok(tags.includes('@saevond'));
  assert.ok(youtubeTagCharacters(tags) <= 500);
  assert.equal(tags.at(-1), '@saevond');
});

test('builds metadata-only updates for public, private, and unlisted videos', () => {
  for (const privacyStatus of ['public', 'private', 'unlisted']) {
    const update = buildCreatorTagUpdate({
      id: 'abcdefghijk',
      etag: 'etag-1',
      snippet: {
        channelId: 'channel-1', title: 'Existing title', description: 'Keep every existing description.',
        categoryId: '20', tags: ['ARC Raiders'], defaultLanguage: 'en',
        defaultAudioLanguage: 'en-US'
      },
      status: { privacyStatus }
    }, 'channel-1');
    assert.equal(update.changed, true);
    assert.equal(update.requestBody.snippet.title, 'Existing title');
    assert.equal(update.requestBody.snippet.description, 'Keep every existing description.');
    assert.equal(update.requestBody.snippet.defaultAudioLanguage, 'en-US');
    assert.ok(update.requestBody.snippet.tags.includes('@saevond'));
    assert.equal(Object.hasOwn(update.requestBody, 'status'), false);
    assert.equal(update.privacyStatus, privacyStatus);
  }
});

test('refuses stale, unknown-owner, and unsupported visibility targets before writing', () => {
  const video = {
    id: 'abcdefghijk', etag: 'etag-1',
    snippet: { channelId: 'channel-2', title: 'Title', description: '', categoryId: '20' },
    status: { privacyStatus: 'public' }
  };
  assert.throws(() => buildCreatorTagUpdate(video, 'channel-1'), /not owned/);
  assert.throws(() => buildCreatorTagUpdate({
    ...video, snippet: { ...video.snippet, channelId: 'channel-1' },
    status: { privacyStatus: 'scheduled' }
  }, 'channel-1'), /unsupported privacy/);
  assert.throws(() => buildCreatorTagUpdate({
    ...video, snippet: { ...video.snippet, channelId: 'channel-1' }, etag: null
  }, 'channel-1'), /version/);
});
