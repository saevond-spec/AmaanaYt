const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlaylistInput, canAddVideoToPlaylist, createYouTubePlaylistClient } = require('../src/youtube-playlists');

test('playlist creation defaults to private and validates privacy and input limits', () => {
  assert.deepEqual(normalizePlaylistInput({ title: '  ARC Raiders  ' }),
    { title: 'ARC Raiders', description: '', privacyStatus: 'private' });
  assert.throws(() => normalizePlaylistInput({ title: ' ' }), /1–150 characters/);
  assert.throws(() => normalizePlaylistInput({ title: 'Gameplay', privacyStatus: 'listed' }), /privacy/);
  assert.throws(() => normalizePlaylistInput({ title: 'Gameplay', description: 'x'.repeat(5001) }), /5,000/);
});

test('non-public videos can only be added to private playlists', () => {
  assert.equal(canAddVideoToPlaylist('public', 'public'), true);
  assert.equal(canAddVideoToPlaylist('public', 'private'), true);
  assert.equal(canAddVideoToPlaylist('unlisted', 'private'), true);
  assert.equal(canAddVideoToPlaylist('private', 'public'), false);
  assert.equal(canAddVideoToPlaylist('private', 'unlisted'), false);
  assert.equal(canAddVideoToPlaylist('unknown', 'private'), false);
});

test('owned playlist listing paginates and returns only display-safe fields', async () => {
  const calls = [];
  const client = createYouTubePlaylistClient(async () => ({ playlists: { list: async (args) => {
    calls.push(args);
    return calls.length === 1
      ? { data: { nextPageToken: 'page-2', items: [{ id: 'PL1', snippet: { title: 'Highlights' }, status: { privacyStatus: 'private' } }] } }
      : { data: { items: [{ id: 'PL2', snippet: { title: 'Public' }, status: { privacyStatus: 'public' } }] } };
  } } }));
  const playlists = await client.listOwnedPlaylists();
  assert.deepEqual(playlists.map((item) => item.id), ['PL1', 'PL2']);
  assert.deepEqual(calls.map((call) => call.mine), [true, true]);
  assert.equal(calls[1].pageToken, 'page-2');
  assert.equal(calls[0].maxResults, 50);
});

test('video playlist insertion is idempotent and uses the YouTube video resource type', async () => {
  const inserted = [];
  let exists = true;
  const client = createYouTubePlaylistClient(async () => ({
    playlistItems: {
      list: async () => ({ data: { items: exists ? [{ id: 'item-1', snippet: { resourceId: { videoId: 'abcdefghijk' } } }] : [] } }),
      insert: async (args) => { inserted.push(args); return { data: { id: 'item-2' } }; }
    }
  }));
  assert.deepEqual(await client.addVideoToPlaylist({ playlistId: 'PL1', videoId: 'abcdefghijk' }),
    { alreadyAdded: true, itemId: 'item-1' });
  assert.equal(inserted.length, 0);
  exists = false;
  assert.deepEqual(await client.addVideoToPlaylist({ playlistId: 'PL1', videoId: 'abcdefghijk' }),
    { alreadyAdded: false, itemId: 'item-2' });
  assert.equal(inserted[0].requestBody.snippet.resourceId.kind, 'youtube#video');
  assert.equal(inserted[0].requestBody.snippet.playlistId, 'PL1');
  await assert.rejects(client.addVideoToPlaylist({ playlistId: 'PL1', videoId: 'bad' }), /11-character/);
});
