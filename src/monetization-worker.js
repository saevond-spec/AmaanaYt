'use strict';

const { isYouTubeAuthorizationError } = require('./channel-tags');
const { callYouTubeDataApi, getYouTubeDataApiQuotaBlock,
  isYouTubeQuotaError, recordYouTubeDataApiQuotaBlock } = require('./youtube-quota');

function createMonetizationWorker({ store, youtube, env = process.env, logger = console }) {
  const enabled = env.YOUTUBE_PUBLIC_LIVE_MONETIZATION === 'true';
  let running = false;
  let lastRun = 0;
  let authorizationBlocked = false;
  let lastResult = { enabled, checkedAt: null, publicBroadcasts: 0, enabledNow: 0,
    ineligible: 0, alreadyOn: 0, authorizationBlocked: false, quotaBlocked: false,
    quotaBlockedUntil: null, errors: [] };

  async function run() {
    if (!enabled || running || authorizationBlocked) return { ...lastResult, authorizationBlocked };
    const existingBlock = await getYouTubeDataApiQuotaBlock(store);
    if (existingBlock) {
      lastResult = { ...lastResult, quotaBlocked: true,
        quotaBlockedUntil: new Date(existingBlock.blockedUntil).toISOString() };
      return { ...lastResult };
    }
    running = true;
    lastRun = Date.now();
    const result = { enabled, checkedAt: new Date().toISOString(), publicBroadcasts: 0,
      enabledNow: 0, ineligible: 0, alreadyOn: 0, authorizationBlocked: false,
      quotaBlocked: false, quotaBlockedUntil: null, errors: [] };
    try {
      if (!await youtube.isConnected()) {
        authorizationBlocked = true;
        result.errors.push('YouTube is not connected');
        logger.warn?.('Public live monetization scan paused; reconnect YouTube in the owner dashboard');
        return result;
      }
      const channel = await callYouTubeDataApi(store, () => youtube.ownedChannel());
      await callYouTubeDataApi(store, () => youtube.assertTargetChannel(channel.id));
      const broadcasts = await callYouTubeDataApi(store, () => youtube.listOwnedBroadcasts());
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
          await callYouTubeDataApi(store, () => youtube.enablePublicBroadcastAds(broadcast));
          result.enabledNow += 1;
          logger.info?.(`Ads enabled for eligible public YouTube broadcast ${broadcast.id}`);
        } catch (error) {
          const apiError = error.response?.data?.error;
          const reason = apiError?.errors?.[0]?.reason;
          const detail = `${error.response?.status || error.code || ''} ${reason || ''} ${apiError?.message || error.message}`.trim();
          result.errors.push(`${broadcast.id}: ${detail.slice(0, 180)}`);
          const quotaBlock = error.youtubeDataApiQuotaBlock ||
            (isYouTubeQuotaError(error) ? await recordYouTubeDataApiQuotaBlock(store, error) : null);
          if (quotaBlock) {
            result.quotaBlocked = true;
            result.quotaBlockedUntil = new Date(quotaBlock.blockedUntil).toISOString();
            logger.warn?.('Public live monetization scan paused until ' + result.quotaBlockedUntil +
              ' after YouTube Data API quota limit');
            break;
          }
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
      const quotaBlock = error.youtubeDataApiQuotaBlock ||
        (isYouTubeQuotaError(error) ? await recordYouTubeDataApiQuotaBlock(store, error) : null);
      if (quotaBlock) {
        result.quotaBlocked = true;
        result.quotaBlockedUntil = new Date(quotaBlock.blockedUntil).toISOString();
        logger.warn?.('Public live monetization scan paused until ' + result.quotaBlockedUntil +
          ' after YouTube Data API quota limit');
      } else if (isYouTubeAuthorizationError(error)) {
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
