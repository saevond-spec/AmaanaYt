'use strict';

const { isYouTubeAuthorizationError } = require('./channel-tags');

function createMonetizationWorker({ youtube, env = process.env, logger = console }) {
  const enabled = env.YOUTUBE_PUBLIC_LIVE_MONETIZATION === 'true';
  let running = false;
  let lastRun = 0;
  let authorizationBlocked = false;
  let lastResult = { enabled, checkedAt: null, publicBroadcasts: 0, enabledNow: 0,
    ineligible: 0, alreadyOn: 0, authorizationBlocked: false, errors: [] };

  async function run() {
    if (!enabled || running || authorizationBlocked) return { ...lastResult, authorizationBlocked };
    running = true;
    lastRun = Date.now();
    const result = { enabled, checkedAt: new Date().toISOString(), publicBroadcasts: 0,
      enabledNow: 0, ineligible: 0, alreadyOn: 0, errors: [] };
    try {
      if (!await youtube.isConnected()) {
        authorizationBlocked = true;
        result.errors.push('YouTube is not connected');
        logger.warn?.('Public live monetization scan paused; reconnect YouTube in the owner dashboard');
        return result;
      }
      const channel = await youtube.ownedChannel();
      await youtube.assertTargetChannel(channel.id);
      const broadcasts = await youtube.listOwnedBroadcasts();
      for (const broadcast of broadcasts) {
        if (broadcast.snippet?.channelId !== channel.id ||
            broadcast.status?.privacyStatus !== 'public' ||
            !['created', 'ready', 'testing', 'live'].includes(broadcast.status?.lifeCycleStatus)) continue;
        result.publicBroadcasts += 1;
        if (broadcast.monetizationDetails?.adsMonetizationStatus === 'on') {
          result.alreadyOn += 1;
          continue;
        }
        if (broadcast.monetizationDetails?.eligibleForAdsMonetization !== true) {
          result.ineligible += 1;
          continue;
        }
        try {
          await youtube.enablePublicBroadcastAds(broadcast);
          result.enabledNow += 1;
          logger.info?.(`Ads enabled for eligible public YouTube broadcast ${broadcast.id}`);
        } catch (error) {
          const apiError = error.response?.data?.error;
          const reason = apiError?.errors?.[0]?.reason;
          const detail = `${error.response?.status || error.code || ''} ${reason || ''} ${apiError?.message || error.message}`.trim();
          result.errors.push(`${broadcast.id}: ${detail.slice(0, 180)}`);
          if (isYouTubeAuthorizationError(error)) {
            authorizationBlocked = true;
            logger.warn?.('Public live monetization scan paused; reconnect YouTube in the owner dashboard');
            break;
          }
          logger.warn?.(`Public broadcast monetization ${broadcast.id} failed: ${detail.slice(0, 300)}; ` +
            `scheduledStart=${Boolean(broadcast.snippet?.scheduledStartTime)}, ` +
            `monitor=${Boolean(broadcast.contentDetails?.monitorStream)}`);
        }
      }
      logger.info?.(`Public live monetization scan: ${result.publicBroadcasts} public, ` +
        `${result.enabledNow} enabled, ${result.alreadyOn} already on, ${result.ineligible} ineligible`);
      return result;
    } catch (error) {
      result.errors.push(String(error.message).slice(0, 180));
      if (isYouTubeAuthorizationError(error)) {
        authorizationBlocked = true;
        logger.warn?.('Public live monetization scan paused; reconnect YouTube in the owner dashboard');
      } else {
        logger.warn?.(`Public live monetization scan failed: ${error.message}`);
      }
      return result;
    } finally {
      result.authorizationBlocked = authorizationBlocked;
      lastResult = result;
      running = false;
    }
  }

  function schedule(force = false) {
    if (!enabled || running || authorizationBlocked || !force && Date.now() - lastRun < 5 * 60 * 1000) return;
    setImmediate(() => { run().catch((error) => logger.warn?.('Live monetization failed:', error.message)); });
  }

  function resumeAfterYouTubeReconnect() {
    authorizationBlocked = false;
    lastRun = 0;
    schedule(true);
  }

  function status() { return { ...lastResult, authorizationBlocked, running }; }
  return { run, schedule, resumeAfterYouTubeReconnect, status };
}

module.exports = { createMonetizationWorker };
