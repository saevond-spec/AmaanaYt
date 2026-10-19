const JAPANESE_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff]/u;
const MAX_CHANNEL_TITLE_LENGTH = 100;
const MAX_CHANNEL_DESCRIPTION_LENGTH = 1000;

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeJapaneseChannelLocalization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('Japanese channel title and description are required');
  }
  if (typeof value.title !== 'string' || typeof value.description !== 'string') {
    throw validationError('Japanese channel title and description must be text');
  }

  const title = value.title.trim();
  const description = value.description.trim();
  if (!title || [...title].length > MAX_CHANNEL_TITLE_LENGTH) {
    throw validationError(`Japanese channel title must be 1–${MAX_CHANNEL_TITLE_LENGTH} characters`);
  }
  if (!description || [...description].length > MAX_CHANNEL_DESCRIPTION_LENGTH) {
    throw validationError(`Japanese channel description must be 1–${MAX_CHANNEL_DESCRIPTION_LENGTH} characters`);
  }
  if (!JAPANESE_SCRIPT.test(description)) {
    throw validationError('Japanese channel description must contain Japanese text');
  }
  return { title, description };
}

function draftJapaneseChannelLocalization({ title = '', description = '' } = {}) {
  const localizedTitle = String(title).trim() || 'Saevond';
  const core = [
    'NARAKA: BLADEPOINTのパートナー、Saevondです。',
    '実況なしのゲームプレイ動画や、配信のハイライトを投稿しています。'
  ].join('\n');
  const sourceLinks = [...new Set(String(description).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /https?:\/\//i.test(line)))];
  const preserved = [];
  let result = core;
  for (const line of sourceLinks) {
    const candidate = `${result}\n\n${line}`;
    if ([...candidate].length <= MAX_CHANNEL_DESCRIPTION_LENGTH) {
      result = candidate;
      preserved.push(line);
    }
  }
  return { title: localizedTitle, description: result, preservedLinks: preserved };
}

module.exports = {
  MAX_CHANNEL_TITLE_LENGTH,
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  normalizeJapaneseChannelLocalization,
  draftJapaneseChannelLocalization
};
