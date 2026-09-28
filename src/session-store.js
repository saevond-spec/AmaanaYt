const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');

async function createSessionStore({ pool, redisUrl, logger = console, createRedisClient = createClient }) {
  if (redisUrl) {
    const client = createRedisClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (attempt) => attempt > 2 ? new Error('Redis connection unavailable') : attempt * 1000
      }
    });
    client.on('error', () => logger.error?.('Redis session connection error'));
    try {
      await client.connect();
      return new RedisStore({ client, prefix: 'amaana:sess:' });
    } catch (_error) {
      client.destroy();
      logger.warn?.('Redis unavailable; using PostgreSQL session store');
    }
  }
  return new PgSession({ pool, tableName: 'amaana_sessions', createTableIfMissing: true });
}

module.exports = { createSessionStore };
