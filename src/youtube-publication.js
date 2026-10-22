'use strict';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function buildPublishStatus({ videoId, current, targetChannelId, publishAt, now = Date.now() }) {
  if (!VIDEO_ID.test(String(videoId || ''))) {
    const error = new Error('A valid 11-character YouTube video ID is required');
    error.status = 400;
    throw error;
  }
  if (!current || current.id !== videoId) {
    const error = new Error('YouTube video changed; refresh before publishing');
    error.status = 409;
    throw error;
  }
  if (!targetChannelId || current.snippet?.channelId !== targetChannelId) {
    const error = new Error('YouTube video is not owned by the configured channel');
    error.status = 403;
    throw error;
  }
  if (current.status?.privacyStatus !== 'private') {
    const error = new Error('Only a private, never-public draft can be published through this action');
    error.status = 409;
    throw error;
  }
  if (!current.etag) {
    const error = new Error('YouTube did not return a video version; refresh before publishing');
    error.status = 409;
    throw error;
  }
  if (publishAt === undefined || publishAt === null || publishAt === '') {
    return { privacyStatus: 'public' };
  }
  const timestamp = Date.parse(publishAt);
  if (!Number.isFinite(timestamp) || timestamp <= Number(now)) {
    const error = new Error('Scheduled publication time must be a valid future date');
    error.status = 400;
    throw error;
  }
  return { privacyStatus: 'private', publishAt: new Date(timestamp).toISOString() };
}

module.exports = { buildPublishStatus };
