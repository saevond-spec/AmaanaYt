const fs = require('fs');
const { google } = require('googleapis');
const store = require('./store');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

async function oauthClient() {
  const redirectUri = new URL('/oauth2/callback', process.env.BASE_URL).toString();
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
  const tokens = await store.getTokens();
  if (tokens) client.setCredentials(tokens);
  client.on('tokens', (fresh) => {
    store.getTokens()
      .then((current) => store.saveTokens({ ...(current || {}), ...fresh }))
      .catch((error) => console.error('Failed to persist refreshed YouTube token:', error.message));
  });
  return client;
}

async function isConnected() {
  const tokens = await store.getTokens();
  return Boolean(tokens?.refresh_token || tokens?.access_token);
}

async function authorizationUrl(state) {
  const client = await oauthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state
  });
}

async function exchangeCode(code) {
  const client = await oauthClient();
  const { tokens } = await client.getToken(code);
  await store.saveTokens(tokens);
  return tokens;
}

async function service() {
  const client = await oauthClient();
  if (!client.credentials?.refresh_token && !client.credentials?.access_token) {
    throw new Error('YouTube is not connected');
  }
  return google.youtube({ version: 'v3', auth: client });
}

async function uploadPrivate({ filePath, title, description, tags, madeForKids = false }) {
  const youtube = await service();
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, tags, categoryId: '20', defaultLanguage: 'en' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: Boolean(madeForKids) }
    },
    media: { body: fs.createReadStream(filePath) }
  });
  return response.data;
}

async function publish(videoId, publishAt) {
  const youtube = await service();
  const status = publishAt
    ? { privacyStatus: 'private', publishAt: new Date(publishAt).toISOString() }
    : { privacyStatus: 'public' };
  const response = await youtube.videos.update({
    part: ['status'],
    requestBody: { id: videoId, status }
  });
  return response.data;
}

async function getVideo(videoId) {
  const youtube = await service();
  const response = await youtube.videos.list({
    part: ['snippet', 'status', 'processingDetails'],
    id: [videoId]
  });
  return response.data.items?.[0] || null;
}

module.exports = { isConnected, authorizationUrl, exchangeCode, uploadPrivate, publish, getVideo };
