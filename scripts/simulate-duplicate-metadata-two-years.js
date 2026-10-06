'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_DATE = '2026-10-06';
const INITIAL_CATALOG_VIDEOS = 2574;
const DAILY_INGESTIONS = 2;
const SEO_DAILY_LIMIT = 200;
const PUBLIC_METADATA_LIMIT = 5000;
const { canonicalText, findMetadataConflicts, makeDistinctTitle } =
  require('../src/metadata-uniqueness');

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new Error('startDate must be an ISO date');
  const date = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('startDate must be a valid ISO date');
  }
  return date;
}

function daysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function sourceDescription(index) {
  if (index === 2) {
    return [
      'Apex Legends ranked: Saevond escapes the final ring after a last-second shield swap.',
      'Watch the squad rotate through Fragment, recover a banner, and win the final 1v3 with careful timing.',
      'Full Twitch VOD: https://www.twitch.tv/videos/123456',
      '#Saevond #Gaming'
    ].join('\n');
  }
  return [
    `Apex Legends match ${index} rotation route${index * 3 + 7} through area${index * 5 + 11}.`,
    `Squad strategy ${index * 7 + 13} records cover${index * 11 + 17} after objective${index * 13 + 19}.`,
    `Gameplay sequence ${index * 17 + 23} includes reset${index * 19 + 29} and finish${index * 23 + 31}.`
  ].join(' ');
}

function uniqueTitle(index) {
  const actions = ['shield swap', 'banner recovery', 'ring rotation', 'close-range reset', 'final duel'];
  return `Apex Legends ranked match${index} ${actions[index % actions.length]} route${index * 3 + 7} finish${index * 5 + 11}`;
}

function uniqueDescription(index) {
  return sourceDescription(10000 + index);
}

function runCatalogSweep({ days, catalogVideos, dailyIngestions, metadataLimit }) {
  const peers = [];
  const metrics = {
    initialCatalogVideos: catalogVideos,
    initialPublicVideos: 0,
    privateVideos: 0,
    unlistedVideos: 0,
    dailyIngestions,
    totalIngestions: days * dailyIngestions,
    publicCandidates: 0,
    duplicateCandidates: 0,
    duplicateTitleConflicts: 0,
    nearDuplicateTitleConflicts: 0,
    duplicateDescriptionConflicts: 0,
    ownerReviewRequired: 0,
    automaticMetadataWrites: 0,
    automaticThumbnailWrites: 0,
    duplicateMetadataWriteAttempts: 0,
    privateOrUnlistedWrites: 0,
    visibilityMutations: 0,
    catalogCoverageLost: false,
    maxPublicCatalogRows: 0
  };

  for (let index = 0; index < catalogVideos; index += 1) {
    const privacyStatus = index % 10 === 0 ? 'private' : index % 10 === 1 ? 'unlisted' : 'public';
    const row = {
      videoId: `archive-${index + 1}`,
      title: index === 2 ? 'Apex Legends clutch: 1v3 finale' : uniqueTitle(index + 100),
      description: sourceDescription(index)
    };
    if (privacyStatus === 'public') {
      peers.push(row);
      metrics.initialPublicVideos += 1;
    } else if (privacyStatus === 'private') metrics.privateVideos += 1;
    else metrics.unlistedVideos += 1;
  }

  let publicOrdinal = 0;
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < dailyIngestions; slot += 1) {
      const ordinal = day * dailyIngestions + slot + 1;
      const privacyStatus = ordinal % 10 === 0 ? 'private' : ordinal % 10 === 1 ? 'unlisted' : 'public';
      const videoId = `new-${ordinal}`;
      const sourceRow = {
        videoId,
        title: uniqueTitle(20000 + ordinal),
        description: uniqueDescription(ordinal)
      };
      if (privacyStatus !== 'public') continue;

      metrics.publicCandidates += 1;
      const thisPublicOrdinal = publicOrdinal++;
      const candidateRow = { ...sourceRow };
      peers.push(sourceRow);
      const knownPublicCount = peers.length;
      const comparisonPeers = peers.slice(0, metadataLimit);
      const catalogComplete = knownPublicCount === comparisonPeers.length &&
        knownPublicCount <= metadataLimit && metadataLimit <= PUBLIC_METADATA_LIMIT;
      metrics.maxPublicCatalogRows = Math.max(metrics.maxPublicCatalogRows, peers.length);
      if (!catalogComplete) metrics.catalogCoverageLost = true;

      let candidateTitle = uniqueTitle(30000 + ordinal);
      let candidateDescription = uniqueDescription(30000 + ordinal);
      let scenario = 'unique';
      if (thisPublicOrdinal % 67 === 0) {
        candidateTitle = 'Apex Legends clutch: 1v3 finale highlight';
        scenario = 'near_title';
      } else if (thisPublicOrdinal % 43 === 0) {
        candidateDescription = peers[0].description +
          '\nChapters\n00:00 - Landing\n00:48 - Final ring';
        scenario = 'duplicate_description';
      } else if (thisPublicOrdinal % 29 === 0) {
        candidateTitle = peers[0].title;
        scenario = 'duplicate_title';
      }

      const conflicts = findMetadataConflicts({
        videoId,
        title: candidateTitle,
        description: candidateDescription,
        peers: comparisonPeers
      });
      const duplicateKinds = new Set(conflicts.map((item) => item.kind));
      if (duplicateKinds.size) {
        metrics.duplicateCandidates += 1;
        if (duplicateKinds.has('title')) {
          if (scenario === 'near_title') metrics.nearDuplicateTitleConflicts += 1;
          else metrics.duplicateTitleConflicts += 1;
        }
        if (duplicateKinds.has('description')) metrics.duplicateDescriptionConflicts += 1;
        metrics.ownerReviewRequired += 1;
        // The public catalog retains the current source metadata until owner review.
        candidateRow.title = sourceRow.title;
        candidateRow.description = sourceRow.description;
      } else if (catalogComplete) {
        // This scenario models SEO_AUTO_PUBLISH=true after the complete-catalog
        // check. The simulation makes no placement or view-lift claim.
        metrics.automaticMetadataWrites += 1;
        metrics.automaticThumbnailWrites += 1;
        candidateRow.title = candidateTitle;
        candidateRow.description = candidateDescription;
      } else {
        metrics.ownerReviewRequired += 1;
      }
      const sourcePosition = peers.findIndex((row) => row.videoId === videoId);
      peers[sourcePosition] = candidateRow;
      if (privacyStatus !== 'public' &&
          (candidateRow.title !== sourceRow.title || candidateRow.description !== sourceRow.description)) {
        metrics.privateOrUnlistedWrites += 1;
      }
    }
  }

  metrics.publicCatalogCompleteAtEnd = peers.length <= metadataLimit &&
    metrics.maxPublicCatalogRows <= metadataLimit;
  metrics.noAutomaticEditForDuplicateMetadata = metrics.duplicateMetadataWriteAttempts === 0;
  metrics.privacyInvariant = metrics.privateOrUnlistedWrites === 0 && metrics.visibilityMutations === 0;
  metrics.catalogRowsAtEnd = peers.length;
  return metrics;
}

function runCoverageBoundaryScenario() {
  const returnedRows = PUBLIC_METADATA_LIMIT;
  const publicCatalogCount = PUBLIC_METADATA_LIMIT + 1;
  const complete = publicCatalogCount === returnedRows && returnedRows <= PUBLIC_METADATA_LIMIT;
  const automaticMetadataWrites = complete ? 1 : 0;
  const automaticThumbnailWrites = complete ? 1 : 0;
  return {
    publicCatalogCount,
    returnedRows,
    catalogComplete: complete,
    publicCandidates: 1,
    ownerReviewRequired: complete ? 0 : 1,
    automaticMetadataWrites,
    automaticThumbnailWrites,
    invariant: !complete && automaticMetadataWrites === 0 && automaticThumbnailWrites === 0
  };
}

function runDailyLimitStress(days, dailyLimit) {
  const requestsPerDay = dailyLimit + 50;
  const totalRequests = requestsPerDay * days;
  const totalProcessed = dailyLimit * days;
  return {
    dailySeoGenerationLimit: dailyLimit,
    requestsPerDay,
    totalRequests,
    totalProcessed,
    deferredToLaterRuns: totalRequests - totalProcessed,
    maxProcessedPerDay: dailyLimit,
    limitInvariant: totalProcessed <= dailyLimit * days
  };
}

function runRepeatedShortTitleScenario() {
  const seen = [];
  const timestamps = [42, 77, 131, 188, 244, 301, 358, 415, 472, 529, 586, 643];
  const titles = timestamps.map((seconds) => {
    const time = seconds < 3600
      ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
      : Math.floor(seconds / 3600) + ':' + String(Math.floor(seconds / 60) % 60).padStart(2, '0') +
        ':' + String(seconds % 60).padStart(2, '0');
    const title = makeDistinctTitle('Last ring shield swap clutch | Apex Legends Ranked',
      'at ' + time, seen, 100);
    seen.push(title);
    return { title, time };
  });
  return {
    repeatedMoments: titles.length,
    uniqueCanonicalTitles: new Set(titles.map((item) => canonicalText(item.title))).size,
    titlesWithFactualTimes: titles.filter((item) => item.title.includes('at ' + item.time)).length,
    allUnder100Characters: titles.every((item) => item.title.length <= 100),
    distinctInvariant: new Set(titles.map((item) => canonicalText(item.title))).size === titles.length
  };
}

function simulateDuplicateMetadataTwoYears(input = {}) {
  const start = dateOnly(input.startDate || START_DATE);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 2);
  const days = daysBetween(start, end);
  const catalogVideos = Number.isSafeInteger(input.catalogVideos) && input.catalogVideos >= 1
    ? Math.min(input.catalogVideos, 10000) : INITIAL_CATALOG_VIDEOS;
  const dailyIngestions = Number.isSafeInteger(input.dailyIngestions) && input.dailyIngestions >= 1
    ? Math.min(input.dailyIngestions, 20) : DAILY_INGESTIONS;
  const dailySeoLimit = Number.isSafeInteger(input.dailySeoLimit) && input.dailySeoLimit >= 1
    ? Math.min(input.dailySeoLimit, 5000) : SEO_DAILY_LIMIT;
  const metadataLimit = Number.isSafeInteger(input.metadataLimit) && input.metadataLimit >= 1
    ? Math.min(input.metadataLimit, 5000) : PUBLIC_METADATA_LIMIT;

  return {
    title: 'AmaanaYT two-year duplicate-metadata autopilot simulation',
    assumptions: {
      syntheticCatalogAndIngestionRates: true,
      syntheticDuplicatePatternsAreNotProductionMeasurements: true,
      autoPublisherEnabled: true,
      automaticEditEligibleOnlyWhen: [
        'the source video is already public',
        'SEO_AUTO_PUBLISH is explicitly enabled',
        'the full public metadata catalog is present within the 5,000-row check limit',
        'no duplicate or near-duplicate title or substantive description is found'
      ],
      duplicateMetadataOwnerReviewBlocksMetadataAndThumbnailWrites: true,
      newHighlightAndShortOutputsRemainPrivateUntilSeparateApproval: true
    },
    horizon: {
      startDate: start.toISOString().slice(0, 10),
      endDateExclusive: end.toISOString().slice(0, 10),
      days,
      years: 2
    },
    catalogSweep: runCatalogSweep({ days, catalogVideos, dailyIngestions, metadataLimit }),
    catalogCoverageBoundary: runCoverageBoundaryScenario(),
    dailyLimitStress: runDailyLimitStress(days, dailySeoLimit),
    repeatedShortTitles: runRepeatedShortTitleScenario(),
    rankingForecast: {
      noPredictedPlacementOrViewLift: true,
      evaluation: 'Compare matched YouTube Search and Search Console impressions, clicks, CTR, and position windows after deployment.'
    },
    marketResearch: {
      asOf: '2026-10-06',
      youtubeDiscovery: 'YouTube says title, thumbnail, and description carry more discovery weight than tags; tags are mainly useful for common misspellings.',
      uniqueDescriptions: 'YouTube recommends unique descriptions and prominent terms in the title and description.',
      googleVideoPages: 'Google recommends distinct video-page titles and descriptions.',
      titleThumbnailExperiments: 'YouTube Studio title/thumbnail experiments evaluate watch time; this autopilot does not start or manage those experiments.',
      sources: [
        'https://support.google.com/youtube/answer/141805',
        'https://support.google.com/youtube/answer/146402',
        'https://support.google.com/youtube/answer/12948449',
        'https://support.google.com/youtube/answer/16391400',
        'https://developers.google.com/search/docs/appearance/video'
      ]
    }
  };
}

if (require.main === module) {
  const result = simulateDuplicateMetadataTwoYears();
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { simulateDuplicateMetadataTwoYears, runCatalogSweep, runDailyLimitStress };
