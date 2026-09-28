const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RedisStore } = require('connect-redis');
const { createSessionStore } = require('../src/session-store');
const { databaseConnectionString } = require('../src/store');

test('uses Redis for sessions when the configured client connects', async () => {
  const client = new EventEmitter();
  client.connect = async () => {};
  client.destroy = () => assert.fail('connected Redis client should be retained');
  const sessionStore = await createSessionStore({ pool: {}, redisUrl: 'redis://localhost:6379',
    createRedisClient: (options) => {
      assert.equal(options.url, 'redis://localhost:6379');
      return client;
    } });
  assert.ok(sessionStore instanceof RedisStore);
});

test('uses PostgreSQL sessions without Redis and if Redis fails to connect', async () => {
  const pool = {};
  const noRedis = await createSessionStore({ pool });
  assert.equal(noRedis.constructor.name, 'PGStore');
  let destroyed = false;
  let warned = false;
  const failed = new EventEmitter();
  failed.connect = async () => { throw new Error('unavailable'); };
  failed.destroy = () => { destroyed = true; };
  const fallback = await createSessionStore({ pool, redisUrl: 'redis://localhost:6379',
    createRedisClient: () => failed, logger: { warn: () => { warned = true; }, error() {} } });
  assert.equal(fallback.constructor.name, 'PGStore');
  assert.equal(destroyed, true);
  assert.equal(warned, true);
});

test('production database URLs use verify-full without an SSL override', () => {
  const base = 'postgresql://user:pass@db.example.com/postgres';
  assert.equal(databaseConnectionString(base, true), `${base}?sslmode=verify-full`);
  assert.equal(databaseConnectionString(`${base}?sslmode=require`, true), `${base}?sslmode=verify-full`);
  assert.equal(databaseConnectionString(`${base}?sslmode=verify-full`, true), `${base}?sslmode=verify-full`);
  assert.equal(databaseConnectionString(base, false), base);
});
