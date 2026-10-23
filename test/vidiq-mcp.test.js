'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MCP_PROTOCOL_VERSION, readJsonRpcResponse, parseSseMessages,
  createVidiqMcpClient } = require('../src/vidiq-mcp');

test('Streamable HTTP event responses select the matching JSON-RPC request', async () => {
  const parsed = parseSseMessages('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n');
  assert.equal(parsed.length, 2);
  const response = new Response('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n', {
    headers: { 'content-type': 'text/event-stream' }
  });
  assert.deepEqual(await readJsonRpcResponse(response, 7), { ok: true });
});

test('MCP client uses the current stateless protocol and invokes only allowlisted read tools', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ payload, headers: options.headers });
    let result;
    if (payload.method === 'server/discover') result = {
      resultType: 'complete', supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'vidiq' } }
    };
    else if (payload.method === 'tools/list') result = { resultType: 'complete', ttlMs: 60000,
      cacheScope: 'private', tools: [
        { name: 'vidiq_user_channels', annotations: { readOnlyHint: true } },
        { name: 'vidiq_balance', annotations: { readOnlyHint: true } }
      ] };
    else result = payload.params.name === 'vidiq_balance'
      ? { resultType: 'complete', content: [{ type: 'text', text: '{"type":"limited","totalCredits":5}' }] }
      : { resultType: 'complete', content: [{ type: 'text', text: '{"channels":[]}' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  const client = createVidiqMcpClient({ apiKey: 'test-secret', fetchImpl });
  const result = await client.callReadOnlyTool('vidiq_user_channels');
  assert.equal(result.content[0].text, '{"channels":[]}');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.headers.Authorization === 'Bearer test-secret'));
  assert.ok(calls.every((call) => call.headers['MCP-Protocol-Version'] === MCP_PROTOCOL_VERSION));
  assert.ok(calls.every((call) => call.payload.params._meta['io.modelcontextprotocol/protocolVersion'] === MCP_PROTOCOL_VERSION));
  assert.equal(calls[0].headers['Mcp-Method'], 'server/discover');
  assert.equal(calls[1].headers['Mcp-Method'], 'tools/list');
  assert.equal(calls[2].headers['Mcp-Method'], 'tools/call');
  assert.equal(calls[2].headers['Mcp-Name'], 'vidiq_user_channels');
  assert.equal(calls[2].payload.params.name, 'vidiq_user_channels');
  const balance = await client.callReadOnlyTool('vidiq_balance');
  assert.equal(JSON.parse(balance.content[0].text).totalCredits, 5);
  assert.equal(calls.length, 6);
  assert.equal(calls[5].headers['Mcp-Name'], 'vidiq_balance');
  await assert.rejects(() => client.callReadOnlyTool('vidiq_update_video', {}), /not allowed/);
  assert.equal(calls.length, 6, 'a disallowed write tool must not reach the server');
});

test('MCP client falls back to legacy initialize only when modern discovery is unsupported', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ payload, headers: options.headers });
    if (payload.method === 'server/discover') return new Response('', { status: 404 });
    if (payload.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'legacy vidiq' } } }), {
      headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'session-1' }
    });
    if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (payload.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { tools: [{ name: 'vidiq_user_channels', annotations: { readOnlyHint: true } }] } }), {
      headers: { 'content-type': 'application/json' }
    });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: '{"channels":[]}' }] } }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  const client = createVidiqMcpClient({ apiKey: 'test-secret', fetchImpl });
  const result = await client.callReadOnlyTool('vidiq_user_channels');
  assert.equal(result.content[0].text, '{"channels":[]}');
  assert.equal(calls[0].payload.method, 'server/discover');
  assert.equal(calls[1].payload.method, 'initialize');
  assert.equal(calls[2].payload.method, 'notifications/initialized');
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'session-1');
  assert.equal(calls[3].payload.method, 'tools/list');
  assert.equal(calls[4].payload.method, 'tools/call');
  assert.equal(calls[4].payload.params.name, 'vidiq_user_channels');
});

test('MCP client rejects unsafe endpoints, negotiates advertised legacy versions, and requires explicit read-only annotations', async () => {
  assert.throws(() => createVidiqMcpClient({ apiKey: 'x', endpoint: 'http://mcp.vidiq.com/mcp' }), /endpoint/);
  let listCalls = 0;
  const fallbackCalls = [];
  const unsupportedVersionFetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    fallbackCalls.push(payload.method);
    if (payload.method === 'server/discover') return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: {
      code: -32022, message: 'Unsupported protocol version', data: { supported: ['2025-11-25'] }
    } }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (payload.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { protocolVersion: '2025-11-25' } }), { headers: { 'content-type': 'application/json' } });
    if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (payload.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { tools: [{ name: 'vidiq_user_channels', annotations: { readOnlyHint: true } }] } }), {
      headers: { 'content-type': 'application/json' }
    });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: '{"channels":[]}' }] } }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  const unsupported = createVidiqMcpClient({ apiKey: 'x', fetchImpl: unsupportedVersionFetch });
  assert.equal((await unsupported.callReadOnlyTool('vidiq_user_channels')).content[0].text, '{"channels":[]}');
  assert.deepEqual(fallbackCalls, ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);

  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.method === 'server/discover') return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {} } }), { headers: { 'content-type': 'application/json' } });
    listCalls += 1;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { tools: [{ name: 'vidiq_keyword_research', annotations: { readOnlyHint: false } }] } }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  const client = createVidiqMcpClient({ apiKey: 'x', fetchImpl });
  await assert.rejects(() => client.callReadOnlyTool('vidiq_keyword_research', { keyword: 'game' }), /explicitly mark.*read-only/);
  assert.equal(listCalls, 1);

  const missingAnnotation = createVidiqMcpClient({ apiKey: 'x', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    const result = payload.method === 'server/discover'
      ? { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {} }
      : { tools: [{ name: 'vidiq_user_channels' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }), {
      headers: { 'content-type': 'application/json' }
    });
  } });
  await assert.rejects(() => missingAnnotation.callReadOnlyTool('vidiq_user_channels'), /explicitly mark.*read-only/);
});
