'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireCompletedYouTubeOutput } = require('../src/highlight-pipeline');
const { requireArchivedTwitchVod } = require('../src/highlight-validation');

const videoId = 'yt-output-123';

function processedOutput(overrides = {}) {
  return {
    id: videoId,
    snippet: { liveBroadcastContent: 'none' },
    status: { uploadStatus: 'processed', privacyStatus: 'private' },
    processingDetails: { processingStatus: 'succeeded' },
    ...overrides
  };
}

function expectStatus(status, callback) {
  assert.throws(callback, (error) => error.status === status);
}

test('a video or Short is finished only with a matching ID and successful upload and processing states', () => {
  for (const outputType of ['video', 'Short']) {
    assert.equal(requireCompletedYouTubeOutput(processedOutput(), videoId, outputType).id, videoId);
    expectStatus(425, () => requireCompletedYouTubeOutput(null, videoId, outputType));
    expectStatus(409, () => requireCompletedYouTubeOutput(processedOutput({ id: undefined }), videoId, outputType));
    expectStatus(409, () => requireCompletedYouTubeOutput(processedOutput({ id: 'another-video' }), videoId, outputType));
    expectStatus(425, () => requireCompletedYouTubeOutput(
      processedOutput({ status: { uploadStatus: 'uploaded' } }), videoId, outputType));
    expectStatus(425, () => requireCompletedYouTubeOutput(
      processedOutput({ processingDetails: { processingStatus: 'processing' } }), videoId, outputType));
    expectStatus(425, () => requireCompletedYouTubeOutput(
      processedOutput({ processingDetails: { processingStatus: 'terminated' } }), videoId, outputType));
    for (const uploadStatus of ['deleted', 'failed', 'rejected']) {
      expectStatus(422, () => requireCompletedYouTubeOutput(
        processedOutput({ status: { uploadStatus } }), videoId, outputType));
    }
    expectStatus(422, () => requireCompletedYouTubeOutput(
      processedOutput({ processingDetails: { processingStatus: 'failed' } }), videoId, outputType));
  }
});

test('a video or Short is not finished while a YouTube livestream is active, upcoming, or unconfirmed', () => {
  for (const liveBroadcastContent of ['live', 'upcoming', undefined]) {
    const output = processedOutput({ snippet: { liveBroadcastContent } });
    expectStatus(425, () => requireCompletedYouTubeOutput(output, videoId, 'video'));
    expectStatus(425, () => requireCompletedYouTubeOutput(output, videoId, 'Short'));
  }
});

test('a livestream source qualifies only after Twitch returns its own archived VOD with a valid duration', () => {
  const archive = { id: '1234567890', user_id: 'saevond-id', type: 'archive', duration: '2h17m30s' };
  assert.equal(requireArchivedTwitchVod(archive, archive.id, 'saevond-id'), archive);
  expectStatus(425, () => requireArchivedTwitchVod(null, archive.id, 'saevond-id'));
  for (const type of ['live', 'highlight', 'upload']) {
    expectStatus(422, () => requireArchivedTwitchVod({ ...archive, type }, archive.id, 'saevond-id'));
  }
  expectStatus(403, () => requireArchivedTwitchVod({ ...archive, user_id: 'someone-else' },
    archive.id, 'saevond-id'));
  expectStatus(409, () => requireArchivedTwitchVod({ ...archive, id: 'different-vod' },
    archive.id, 'saevond-id'));
  expectStatus(422, () => requireArchivedTwitchVod({ ...archive, duration: '0s' },
    archive.id, 'saevond-id'));
});
