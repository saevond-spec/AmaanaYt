'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('finds only the connected broadcaster’s active archive VOD', async (t) => {
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const originalEnv = {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET
  };
  const calls = [];
  const tokens = { access_token: 'fixture-token', refresh_token: 'fixture-refresh',
    expires_at: Date.now() + 60 * 60 * 1000 };
  const fakeStore = {
    async getTwitchTokens() { return tokens; },
    async saveTwitchTokens(value) { Object.assign(tokens, value); }
  };
  const twitchPath = require.resolve('../src/twitch');
  Module._load = function (request, parent, isMain) {
    if (request === './store' && parent && parent.filename === twitchPath) return fakeStore;
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.TWITCH_CLIENT_ID = 'fixture-client';
  process.env.TWITCH_CLIENT_SECRET = 'fixture-secret';
  global.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    let body = {};
    if (url.pathname === '/oauth2/validate') {
      body = { client_id: 'fixture-client', expires_in: 3600 };
    } else if (url.pathname === '/helix/users') {
      body = { data: [{ id: '1001', login: 'amaanayt' }] };
    } else if (url.pathname === '/helix/streams') {
      body = { data: [{ id: '7777', user_id: '1001', started_at: '2026-10-19T10:00:00Z' }] };
    } else if (url.pathname === '/helix/videos') {
      if (url.searchParams.get('first') === '2' && url.searchParams.get('after') === 'cursor-1') {
        body = { data: [
          { id: '6001', stream_id: '5555', user_id: '1001', type: 'archive', duration: '2h' }
        ] };
      } else if (url.searchParams.get('first') === '2') {
        body = { data: [
          { id: '9001', stream_id: '7777', user_id: '1001', type: 'archive', duration: '1h' },
          { id: '8001', stream_id: '6666', user_id: '1001', type: 'archive', duration: '2h' }
        ], pagination: { cursor: 'cursor-1' } };
      } else {
        body = { data: [
          { id: '9001', stream_id: '7777', user_id: '1001', type: 'archive', duration: '1h' },
          { id: '8001', stream_id: '6666', user_id: '1001', type: 'archive', duration: '2h' },
          { id: '7001', stream_id: '7777', user_id: '2002', type: 'archive', duration: '1h' }
        ] };
      }
    } else if (url.pathname === '/helix/clips') {
      body = { data: [
        { id: 'live-clip-1', broadcaster_id: '1001', game_id: '509658', duration: 30 },
        { id: 'other-channel-clip', broadcaster_id: '2002', game_id: '509658', duration: 30 }
      ] };
    }
    return new Response(JSON.stringify(body), { status: 200,
      headers: { 'content-type': 'application/json' } });
  };
  delete require.cache[twitchPath];
  const twitch = require('../src/twitch');
  t.after(() => {
    Module._load = originalLoad;
    global.fetch = originalFetch;
    if (originalEnv.clientId === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = originalEnv.clientId;
    if (originalEnv.clientSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
    else process.env.TWITCH_CLIENT_SECRET = originalEnv.clientSecret;
    delete require.cache[twitchPath];
  });

  const broadcast = await twitch.getLiveBroadcast();
  const clips = await twitch.listRecentLiveClips({
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    endedAt: new Date().toISOString()
  });
  const archivedVods = await twitch.listRecentArchivedVods({ first: 2, maxPages: 2 });

  assert.equal(broadcast.user.id, '1001');
  assert.deepEqual(clips.map((clip) => clip.id), ['live-clip-1']);
  assert.deepEqual(archivedVods.map((vod) => vod.id), ['8001', '6001']);
  assert.ok(calls.some((call) => call.includes('first=2&after=cursor-1')));
  assert.equal(broadcast.stream.id, '7777');
  assert.equal(broadcast.vod.id, '9001');
  assert.ok(calls.some((call) => call.startsWith('/helix/streams?user_id=1001')));
  assert.ok(calls.some((call) => call.startsWith('/helix/videos?user_id=1001')));
  assert.ok(calls.some((call) => call.startsWith('/helix/clips?broadcaster_id=1001')));
});
