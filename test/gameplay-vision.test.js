const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeGameplayFrames, configuredProviders, getGameplayVisionStatus,
  resolveImageLimit, selectRepresentativeFrames } = require('../src/gameplay-vision');
const { createModelCircuitBreaker } = require('../src/seo-package');

const frames = Array.from({ length: 5 }, (_, index) => ({
  mimeType: 'image/jpeg', data: Buffer.from(`sample-${index}`).toString('base64'), timestampSeconds: index * 12
}));

const assessment = {
  gameName: 'Example game',
  eventTypes: ['fight'],
  eventEvidence: { fight: 'A player attacks a visible enemy.' },
  eventMarkers: [{ eventType: 'fight', frameIndex: 2, confidence: 0.94,
    evidence: 'A player and enemy exchange attacks.' }],
  frames: frames.map(() => ({ activeGameplay: true, confidence: 0.95, evidence: 'The game world and HUD are visible.' }))
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
    async json() { return body; } };
}

test('screening auto-enables from provider presence without a positive gameplay flag', () => {
  const status = getGameplayVisionStatus({ GEMINI_API_KEY: 'gemini-secret', ENABLE_GAMEPLAY_SCREENING: 'auto' });
  assert.equal(status.enabled, true);
  assert.deepEqual(status.configuredProviders, ['gemini']);
  assert.equal(status.explicitlyDisabled, false);
  assert.equal(JSON.stringify(status).includes('gemini-secret'), false);
});

test('explicit false remains a kill switch and missing providers fail closed', () => {
  assert.deepEqual(getGameplayVisionStatus({ ENABLE_GAMEPLAY_SCREENING: 'false',
    GAMEPLAY_VISION_OPENAI_API_KEY: 'openai-secret' }), {
    enabled: false, explicitlyDisabled: true, configuredProviders: ['openai'], unavailableReason: 'disabled_by_configuration'
  });
  assert.equal(getGameplayVisionStatus({}).unavailableReason, 'no_vision_provider_configured');
});

test('provider status supports Gemini, OpenAI, compatible gateways, Anthropic, and keyless Ollama', () => {
  const env = {
    GAMEPLAY_VISION_PROVIDER_ORDER: 'gemini,openai,openai-compatible,anthropic,ollama',
    GAMEPLAY_VISION_GEMINI_API_KEY: 'gemini-secret',
    GAMEPLAY_VISION_OPENAI_API_KEY: 'openai-secret',
    GAMEPLAY_VISION_OPENAI_COMPAT_BASE_URL: 'https://api.groq.com/openai/v1',
    GAMEPLAY_VISION_OPENAI_COMPAT_API_KEY: 'groq-secret',
    GAMEPLAY_VISION_OPENAI_COMPAT_MODEL: 'vision-model',
    GAMEPLAY_VISION_ANTHROPIC_API_KEY: 'anthropic-secret',
    GAMEPLAY_VISION_OLLAMA_BASE_URL: 'http://ollama.internal:11434'
  };
  assert.deepEqual(configuredProviders(env).map((provider) => provider.name),
    ['gemini', 'openai', 'openai_compatible', 'anthropic', 'ollama']);
  assert.deepEqual(getGameplayVisionStatus(env).configuredProviders,
    ['gemini', 'openai', 'openai_compatible', 'anthropic', 'ollama']);
  assert.equal(configuredProviders(env)[1].model, 'gpt-4.1-mini');
  assert.equal(configuredProviders(env)[3].model, 'claude-haiku-5-5');
  assert.equal(configuredProviders(env)[2].maxImages, 3);
});

test('compatible-provider image limits select frames evenly across the sampled segment', () => {
  assert.equal(resolveImageLimit('2'), 3);
  assert.equal(resolveImageLimit('8'), 8);
  assert.deepEqual(selectRepresentativeFrames(frames, 3).map((frame) => frame.timestampSeconds), [0, 24, 48]);
});

test('Gemini transient failure falls through to a Groq-compatible vision endpoint', async () => {
  const urls = [];
  const requests = [];
  const result = await analyzeGameplayFrames(frames, {
    env: {
      GAMEPLAY_VISION_PROVIDER_ORDER: 'gemini,openai_compatible',
      GAMEPLAY_VISION_GEMINI_API_KEY: 'gemini-secret',
      GAMEPLAY_VISION_OPENAI_COMPAT_BASE_URL: 'https://api.groq.com/openai/v1',
      GAMEPLAY_VISION_OPENAI_COMPAT_API_KEY: 'groq-secret',
      GAMEPLAY_VISION_OPENAI_COMPAT_MODEL: 'vision-model'
    },
    circuitBreaker: createModelCircuitBreaker(),
    fetchImpl: async (url, options) => {
      urls.push(url);
      requests.push({ headers: options.headers, body: JSON.parse(options.body) });
      return urls.length === 1 ? jsonResponse({}, 503)
        : jsonResponse({ choices: [{ message: { content: JSON.stringify({ ...assessment,
          frames: assessment.frames.filter((_, index) => [0, 2, 4].includes(index)) }) } }] });
    }
  });
  assert.deepEqual(urls, [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    'https://api.groq.com/openai/v1/chat/completions'
  ]);
  assert.equal(requests[0].headers['x-goog-api-key'], 'gemini-secret');
  assert.equal(requests[1].headers.authorization, 'Bearer groq-secret');
  assert.equal(requests[1].body.messages[0].content.filter((part) => part.type === 'image_url').length, 3);
  assert.equal(requests[1].body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'), true);
  assert.equal(result.provider, 'openai_compatible');
  assert.deepEqual(result.eventMarkers, [{ eventType: 'fight', frameIndex: 2,
    offsetSeconds: 48, confidence: 0.94, evidence: 'A player and enemy exchange attacks.' }]);
});

test('OpenAI Responses adapter sends sampled images and parses text output', async () => {
  let request;
  const result = await analyzeGameplayFrames(frames, {
    env: { GAMEPLAY_VISION_PROVIDER_ORDER: 'openai', GAMEPLAY_VISION_OPENAI_API_KEY: 'openai-secret' },
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse({ output_text: JSON.stringify(assessment) });
    }
  });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.authorization, 'Bearer openai-secret');
  assert.equal(request.body.input[0].content[1].type, 'input_image');
  assert.equal(result.provider, 'openai');
});

test('Anthropic adapter uses base64 image blocks and parses Messages output', async () => {
  let request;
  const result = await analyzeGameplayFrames(frames, {
    env: { GAMEPLAY_VISION_PROVIDER_ORDER: 'anthropic', GAMEPLAY_VISION_ANTHROPIC_API_KEY: 'anthropic-secret' },
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(assessment) }] });
    }
  });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'anthropic-secret');
  assert.equal(request.body.messages[0].content[1].source.data, frames[0].data);
  assert.equal(result.provider, 'anthropic');
});

test('Ollama vision adapter works without a provider API key', async () => {
  let request;
  const result = await analyzeGameplayFrames(frames, {
    env: { GAMEPLAY_VISION_PROVIDER_ORDER: 'ollama', GAMEPLAY_VISION_OLLAMA_BASE_URL: 'http://ollama.internal:11434' },
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse({ message: { content: JSON.stringify(assessment) } });
    }
  });
  assert.equal(request.url, 'http://ollama.internal:11434/api/chat');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.messages[0].images[0], frames[0].data);
  assert.equal(result.provider, 'ollama');
});

test('invalid provider output falls through and no marker is fabricated', async () => {
  const calls = [];
  const result = await analyzeGameplayFrames(frames, {
    env: { GAMEPLAY_VISION_PROVIDER_ORDER: 'gemini,openai',
      GAMEPLAY_VISION_GEMINI_API_KEY: 'gemini-secret', GAMEPLAY_VISION_OPENAI_API_KEY: 'openai-secret' },
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1 ? jsonResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })
        : jsonResponse({ output_text: JSON.stringify({ ...assessment, eventMarkers: [] }) });
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.provider, 'openai');
  assert.deepEqual(result.eventMarkers, []);
});

test('legacy API-key override still selects Gemini for existing callers', async () => {
  let requestUrl;
  const result = await analyzeGameplayFrames(frames, {
    apiKey: 'legacy-key', model: 'gemini-3.8-flash',
    env: { ENABLE_GAMEPLAY_SCREENING: 'auto' },
    fetchImpl: async (url) => { requestUrl = url; return jsonResponse({ candidates: [
      { content: { parts: [{ text: JSON.stringify(assessment) }] } }
    ] }); }
  });
  assert.match(requestUrl, /gemini-3\.8-flash:generateContent$/);
  assert.equal(result.provider, 'gemini');
});
