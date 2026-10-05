const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeYouTubeOAuthTokens } = require('../src/youtube-oauth');

test('keeps the refresh token and records requested scopes when Google omits scope', () => {
  const saved = mergeYouTubeOAuthTokens(
    { refresh_token: 'old-refresh', scope: 'previous-scope' },
    { access_token: 'new-access' },
    ['youtube.readonly', 'yt-analytics.readonly']
  );
  assert.equal(saved.refresh_token, 'old-refresh');
  assert.equal(saved.access_token, 'new-access');
  assert.equal(saved.scope, 'youtube.readonly yt-analytics.readonly');
});

test('does not claim a scope Google explicitly did not grant', () => {
  const saved = mergeYouTubeOAuthTokens(
    { refresh_token: 'old-refresh' },
    { access_token: 'new-access', scope: 'youtube.readonly' },
    ['youtube.readonly', 'yt-analytics.readonly']
  );
  assert.equal(saved.scope, 'youtube.readonly');
  assert.equal(saved.refresh_token, 'old-refresh');
});

test('replaces the prior refresh token when Google issues a new one', () => {
  const saved = mergeYouTubeOAuthTokens(
    { refresh_token: 'old-refresh' },
    { access_token: 'new-access', refresh_token: 'new-refresh', scope: 'yt-analytics.readonly' },
    ['youtube.readonly', 'yt-analytics.readonly']
  );
  assert.equal(saved.refresh_token, 'new-refresh');
  assert.equal(saved.scope, 'yt-analytics.readonly');
});

test('rejects an invalid OAuth token response', () => {
  assert.throws(() => mergeYouTubeOAuthTokens({}, null, []), /did not return/);
});
