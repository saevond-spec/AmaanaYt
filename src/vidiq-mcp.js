'use strict';

const MCP_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';
const MCP_META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities'
};
const READ_ONLY_TOOLS = new Set(['vidiq_user_channels', 'vidiq_balance', 'vidiq_keyword_research']);

function parseSseMessages(body) {
  const messages = [];
  let data = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!line) {
      if (data.length) {
        try { messages.push(JSON.parse(data.join('\n'))); } catch { /* Ignore non-JSON SSE events. */ }
      }
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length) {
    try { messages.push(JSON.parse(data.join('\n'))); } catch { /* Ignore non-JSON SSE events. */ }
  }
  return messages;
}

function makeRpcError(message, status) {
  const error = new Error(`VidIQ MCP ${message?.error?.code ?? `HTTP ${status}`}: ` +
    String(message?.error?.message || 'request failed').slice(0, 200));
  error.status = status;
  if (message?.error) {
    error.code = message.error.code;
    error.data = message.error.data;
  }
  return error;
}

async function parseResponseMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  let messages;
  if (contentType.includes('text/event-stream')) messages = parseSseMessages(body);
  else {
    try { messages = [JSON.parse(body)]; }
    catch {
      const error = new Error(`VidIQ MCP returned an unsupported response format (HTTP ${response.status})`);
      error.status = response.status;
      error.responseBody = body.slice(0, 200);
      throw error;
    }
  }
  return { body, messages };
}

async function readJsonRpcResponse(response, requestId) {
  const { messages } = await parseResponseMessage(response);
  const message = messages.find((item) => item?.id === requestId);
  if (!response.ok) throw makeRpcError(message, response.status);
  if (!message) throw new Error('VidIQ MCP response did not contain the matching request ID');
  if (message.error) throw makeRpcError(message, response.status);
  return message.result;
}

function isRecognizedModernError(error) {
  return [-32020, -32022].includes(Number(error?.code));
}

function latestSupportedVersion(versions) {
  if (!Array.isArray(versions)) return null;
  const candidates = versions.filter((version) => typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version));
  return candidates.sort().at(-1) || null;
}

function createVidiqMcpClient({ apiKey, endpoint = 'https://mcp.vidiq.com/mcp',
  fetchImpl = fetch, timeoutMs = 30000, protocolVersion = MCP_PROTOCOL_VERSION,
  legacyProtocolVersion = LEGACY_PROTOCOL_VERSION, clientInfo = { name: 'amaana-yt', version: '1.0.0' } } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is required for the VidIQ MCP client');
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' || endpointUrl.hostname !== 'mcp.vidiq.com' || endpointUrl.pathname !== '/mcp') {
    throw new Error('VidIQ MCP endpoint must be https://mcp.vidiq.com/mcp');
  }
  let requestId = 0;

  async function post(payload, version, { method = payload.method, name = null, legacy = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    if (version) headers['MCP-Protocol-Version'] = version;
    if (!legacy) headers['Mcp-Method'] = method;
    if (!legacy && name) headers['Mcp-Name'] = name;
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(payload),
        signal: controller.signal, redirect: 'error' });
      const parsed = await parseResponseMessage(response);
      const message = payload.id === undefined ? null : parsed.messages.find((item) => item?.id === payload.id);
      if (!response.ok || message?.error) throw makeRpcError(message, response.status);
      if (payload.id !== undefined && !message) {
        const error = new Error('VidIQ MCP response did not contain the matching request ID');
        error.status = response.status;
        throw error;
      }
      return { response, result: message?.result ?? null };
    } finally {
      clearTimeout(timeout);
    }
  }

  function modernRequest(method, params, version, id = ++requestId) {
    return { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      [MCP_META.protocolVersion]: version,
      [MCP_META.clientInfo]: clientInfo,
      [MCP_META.clientCapabilities]: {}
    } } };
  }

  async function connectLegacy(version = legacyProtocolVersion) {
    const initializeId = ++requestId;
    const initialized = await post({ jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo
    } }, version, { legacy: true });
    const result = initialized.result;
    const sessionId = initialized.response.headers.get('Mcp-Session-Id');
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    headers['MCP-Protocol-Version'] = result?.protocolVersion || version;
    const notificationController = new AbortController();
    const notificationTimeout = setTimeout(() => notificationController.abort(), timeoutMs);
    try {
      const notification = await fetchImpl(endpoint, { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: notificationController.signal, redirect: 'error' });
      if (!notification.ok) {
        const error = new Error(`VidIQ MCP initialization notification failed: HTTP ${notification.status}`);
        error.status = notification.status;
        throw error;
      }
      await notification.text().catch(() => '');
    } finally {
      clearTimeout(notificationTimeout);
    }

    async function request(method, params) {
      const id = ++requestId;
      const current = await post({ jsonrpc: '2.0', id, method, params }, headers['MCP-Protocol-Version'], { legacy: true });
      return current.result;
    }
    const listed = await request('tools/list', {});
    return { protocolVersion: headers['MCP-Protocol-Version'], era: 'legacy',
      serverInfo: result?.serverInfo || null, tools: Array.isArray(listed?.tools) ? listed.tools : [], request };
  }

  async function connectModern(version = protocolVersion) {
    const discoveryId = ++requestId;
    let response;
    try {
      response = await post(modernRequest('server/discover', {}, version, discoveryId), version);
    } catch (error) {
      if (Number(error.code) !== -32022) throw error;
      const supported = latestSupportedVersion(error.data?.supported);
      if (!supported) throw error;
      if (supported < '2026-07-28') return connectLegacy(supported);
      if (supported === version) throw error;
      return connectModern(supported);
    }
    const supported = response.result?.supportedVersions;
    if (!supported?.includes(version)) {
      const preferred = latestSupportedVersion(supported);
      if (!preferred) throw new Error('VidIQ MCP discovery omitted supported protocol versions');
      if (preferred < '2026-07-28') return connectLegacy(preferred);
      return connectModern(preferred);
    }
    const serverInfo = response.result?._meta?.['io.modelcontextprotocol/serverInfo'] || null;

    async function request(method, params) {
      const id = ++requestId;
      const args = { ...params };
      const name = args.name || null;
      const current = await post(modernRequest(method, args, version, id), version, { method, name });
      return current.result;
    }
    const listed = await request('tools/list', {});
    return { protocolVersion: version, era: 'modern', serverInfo,
      tools: Array.isArray(listed?.tools) ? listed.tools : [], request };
  }

  async function connect() {
    if (!apiKey) throw new Error('Configure VIDIQ_MCP_API_KEY for read-only VidIQ research');
    try {
      return await connectModern();
    } catch (error) {
      // Modern 400s can describe a protocol/header error; never hide those by trying legacy mode.
      if (isRecognizedModernError(error)) throw error;
      if ([400, 404, 405].includes(Number(error.status))) return connectLegacy();
      throw error;
    }
  }

  async function callReadOnlyTool(name, args = {}) {
    if (!READ_ONLY_TOOLS.has(name)) throw new Error(`VidIQ tool ${name} is not allowed in read-only Amaana integration`);
    const session = await connect();
    const definition = session.tools.find((tool) => tool?.name === name);
    if (!definition) throw new Error(`VidIQ MCP does not expose the required ${name} tool`);
    if (definition.annotations?.readOnlyHint !== true || definition.annotations?.destructiveHint === true) {
      throw new Error(`VidIQ MCP did not explicitly mark ${name} as read-only; request blocked`);
    }
    const result = await session.request('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(`VidIQ ${name} returned an error result`);
    return result;
  }

  return { callReadOnlyTool };
}

module.exports = { MCP_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, MCP_META, READ_ONLY_TOOLS,
  parseSseMessages, readJsonRpcResponse, latestSupportedVersion, createVidiqMcpClient };
