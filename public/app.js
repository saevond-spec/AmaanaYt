const loginView = document.querySelector('#loginView');
const dashboardView = document.querySelector('#dashboardView');
const loginForm = document.querySelector('#loginForm');
const uploadForm = document.querySelector('#uploadForm');
const notice = document.querySelector('#notice');
const connectionDot = document.querySelector('#connectionDot');
const connectionText = document.querySelector('#connectionText');
const connectionHelp = document.querySelector('#connectionHelp');
const connectButton = document.querySelector('#connectButton');
const twitchConnectionDot = document.querySelector('#twitchConnectionDot');
const twitchConnectionText = document.querySelector('#twitchConnectionText');
const twitchConnectionHelp = document.querySelector('#twitchConnectionHelp');
const twitchConnectButton = document.querySelector('#twitchConnectButton');
const tiktokConnectionDot = document.querySelector('#tiktokConnectionDot');
const tiktokConnectionText = document.querySelector('#tiktokConnectionText');
const tiktokConnectionHelp = document.querySelector('#tiktokConnectionHelp');
const tiktokConnectButton = document.querySelector('#tiktokConnectButton');
const draftList = document.querySelector('#draftList');
const uploadButton = document.querySelector('#uploadButton');
const seoList = document.querySelector('#seoList');
const seoStatus = document.querySelector('#seoStatus');
const seoToggle = document.querySelector('#seoToggle');
const seoPrevious = document.querySelector('#seoPrevious');
const seoNext = document.querySelector('#seoNext');
const seoPage = document.querySelector('#seoPage');
const seoChannel = document.querySelector('#seoChannel');
let seoOffset = 0;
let seoEnabled = true;
let draftPoll = null;
let tiktokConnected = false;

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.remove('hidden', 'error');
  if (isError) notice.classList.add('error');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearNotice() {
  notice.textContent = '';
  notice.classList.add('hidden');
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'object' ? data.error : data;
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin() {
  if (draftPoll) clearInterval(draftPoll);
  draftPoll = null;
  loginView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  refreshDashboard();
  if (!draftPoll) draftPoll = setInterval(() => {
    if (!document.hidden) loadDrafts();
  }, 12000);
}

async function refreshConnection() {
  const status = await api('/api/youtube/status');
  connectionDot.classList.toggle('connected', status.connected);
  connectionText.textContent = status.connected ? 'Connected' : 'Not connected';
  connectionHelp.textContent = status.connected
    ? (status.canApprove
      ? 'Amaana can upload private drafts. You can approve publishing if Google permits it for this API project.'
      : 'Private uploads work. Reconnect YouTube to grant permission for owner approval and scheduling.')
    : 'Connect the Google account that owns @saevond.';
  connectButton.textContent = status.connected ? 'Reconnect YouTube' : 'Connect YouTube';
}

async function refreshTwitchConnection() {
  const status = await api('/api/twitch/status');
  twitchConnectionDot.classList.toggle('connected', status.connected);
  twitchConnectionText.textContent = status.connected
    ? `Connected as ${status.displayName || status.login || 'Twitch user'}`
    : 'Not connected';
  if (!status.configured) {
    twitchConnectionHelp.textContent = 'Add the Twitch Client ID and Client Secret in Render first.';
    twitchConnectButton.disabled = true;
    twitchConnectButton.textContent = 'Setup required';
  } else {
    twitchConnectionHelp.textContent = status.connected
      ? 'Amaana can create and download clips from your Twitch VODs.'
      : (status.error || 'Connect the Twitch account that owns the Saevond channel.');
    twitchConnectButton.disabled = false;
    twitchConnectButton.textContent = status.connected ? 'Reconnect Twitch' : 'Connect Twitch';
  }
}

async function refreshTikTokConnection() {
  const status = await api('/api/tiktok/status');
  tiktokConnected = status.connected;
  tiktokConnectionDot.classList.toggle('connected', status.connected);
  tiktokConnectionText.textContent = status.connected
    ? `Connected as ${status.displayName || 'TikTok creator'}` : 'Not connected';
  tiktokConnectButton.disabled = !status.configured;
  tiktokConnectButton.textContent = !status.configured ? 'Setup required'
    : status.connected ? 'Reconnect TikTok' : 'Connect TikTok';
  tiktokConnectionHelp.textContent = !status.configured
    ? 'Add a TikTok developer app key and secret in Render, and approve video.upload.'
    : status.connected
      ? 'Review each Short and enable automatic TikTok delivery. Amaana sends it after its public YouTube video exceeds 2,000 views; finish posting in your TikTok inbox.'
      : status.error || 'Connect your TikTok account to send reviewed Shorts to its inbox.';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function approveDraft(id, publishAt, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = publishAt ? 'Scheduling…' : 'Publishing…';
  try {
    await api(`/api/drafts/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishAt: publishAt || null })
    });
    showNotice(publishAt ? 'Short scheduled successfully.' : 'Short published successfully.');
    await loadDrafts();
  } catch (error) {
    showNotice(error.message, true);
    button.disabled = false;
    button.textContent = original;
  }
}

function renderDraft(draft) {
  const isHighlight = draft.sourceType === 'twitch_highlight_batch';
  const card = element('article', 'draft');
  const top = element('div', 'draft-top');
  top.append(element('h3', '', draft.title || (isHighlight ? 'Untitled highlight video' : 'Untitled Short')));
  top.append(element('span', 'draft-status', String(draft.status || 'unknown').replaceAll('_', ' ')));
  card.append(top);

  const created = draft.createdAt ? new Date(draft.createdAt).toLocaleString() : 'Unknown date';
  card.append(element('p', 'draft-meta', `Created ${created}`));

  if (draft.sourceType === 'twitch_vod') {
    const source = element('p', 'draft-meta', `Twitch VOD ${draft.vodId} · ${Math.round(draft.startSeconds || 0)}s–${Math.round(draft.endSeconds || 0)}s`);
    card.append(source);
    if (draft.twitchUrl) {
      const twitchLink = element('a', 'ghost video-link');
      twitchLink.href = draft.twitchUrl;
      twitchLink.target = '_blank';
      twitchLink.rel = 'noopener noreferrer';
      twitchLink.textContent = 'Open Twitch clip';
      card.append(twitchLink);
    }
  }
  if (isHighlight) card.append(element('p', 'draft-meta', `Twitch VOD ${draft.vodId} · ${(draft.highlights || []).length} selected moments · highlight video`));
  if (draft.sourceType === 'twitch_highlight_short') card.append(element('p', 'draft-meta', 'Short made from a highlight video'));

  if (draft.error) card.append(element('p', 'draft-error', draft.error));

  if (draft.youtubeUrl || draft.youtubeVideoId) {
    const link = element('a', 'ghost video-link');
    link.href = draft.youtubeUrl || `https://youtu.be/${encodeURIComponent(draft.youtubeVideoId)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on YouTube';
    card.append(link);
  }

  if (draft.sourceType === 'twitch_highlight_short' && draft.youtubeVideoId) {
    const status = draft.tiktokStatus || 'not_sent';
    const eligible = draft.tiktokEligible && draft.youtubePrivacyStatus === 'public' && draft.youtubeViews > 2000;
    const viewText = Number.isSafeInteger(draft.youtubeViews)
      ? `${draft.youtubeViews.toLocaleString()} YouTube views` : 'YouTube views not checked yet';
    card.append(element('p', 'draft-meta', `${viewText} · ${eligible ? 'Eligible for TikTok' : 'TikTok requires a public Short with more than 2,000 views'}`));
    const checkViews = element('button', 'ghost', 'Check YouTube views');
    checkViews.type = 'button';
    checkViews.addEventListener('click', async () => {
      checkViews.disabled = true;
      try {
        const result = await api(`/api/drafts/${encodeURIComponent(draft.id)}/youtube-views`);
        showNotice(result.eligible
          ? `Short eligible: ${result.views.toLocaleString()} YouTube views.`
          : `TikTok needs over 2,000 public YouTube views. Current views: ${result.views?.toLocaleString() ?? 'unavailable'}.`);
        await loadDrafts();
      } catch (error) { showNotice(error.message, true); checkViews.disabled = false; }
    });
    card.append(checkViews);
    card.append(element('p', 'draft-meta', `TikTok: ${status.replaceAll('_', ' ')}`));
    if (draft.tiktokError) card.append(element('p', 'draft-error', draft.tiktokError));
    const caption = `${draft.title || 'Saevond livestream highlight'} #Saevond #Gaming`;
    if ((!draft.tiktokPublishId && status !== 'preparing') || status === 'failed') {
      const captionBox = element('p', 'draft-meta', `Suggested TikTok caption: ${caption}`);
      card.append(captionBox);
      const copy = element('button', 'ghost', 'Copy TikTok caption');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(caption); showNotice('Caption copied for TikTok.'); }
        catch { showNotice('Select and copy the suggested caption above.', true); }
      });
      card.append(copy);
      if (!draft.tiktokAttemptedAt && status !== 'failed') {
        if (draft.tiktokAutoSendConsent) {
          card.append(element('p', 'draft-meta', 'Automatic TikTok inbox delivery enabled for this Short. It will run after the public YouTube Short exceeds 2,000 views.'));
          const cancelAuto = element('button', 'ghost', 'Turn off automatic delivery');
          cancelAuto.type = 'button';
          cancelAuto.addEventListener('click', async () => {
            cancelAuto.disabled = true;
            try {
              await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-auto`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ consent: false })
              });
              showNotice('Automatic TikTok delivery turned off for this Short.');
              await loadDrafts();
            } catch (error) { showNotice(error.message, true); cancelAuto.disabled = false; }
          });
          card.append(cancelAuto);
        } else {
          const autoConsentRow = element('label', 'check-row');
          const autoConsent = document.createElement('input');
          autoConsent.type = 'checkbox';
          autoConsentRow.append(autoConsent, element('span', '', 'I reviewed this Short and authorize Amaana to send its video and audio to my TikTok inbox automatically once it exceeds 2,000 public YouTube views. I will finish publishing in TikTok.'));
          card.append(autoConsentRow);
          const enableAuto = element('button', 'ghost', 'Enable automatic TikTok delivery');
          enableAuto.type = 'button';
          enableAuto.disabled = true;
          autoConsent.addEventListener('change', () => { enableAuto.disabled = !tiktokConnected || !autoConsent.checked; });
          enableAuto.addEventListener('click', async () => {
            enableAuto.disabled = true;
            try {
              await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-auto`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ consent: autoConsent.checked })
              });
              showNotice('Automatic TikTok inbox delivery enabled for this Short after it passes 2,000 public YouTube views.');
              await loadDrafts();
            } catch (error) { showNotice(error.message, true); enableAuto.disabled = !tiktokConnected || !autoConsent.checked; }
          });
          card.append(enableAuto);
        }
      }
      if (!draft.tiktokAutoSendConsent || status === 'failed') {
        const consentRow = element('label', 'check-row');
        const consent = document.createElement('input');
        consent.type = 'checkbox';
        consentRow.append(consent, element('span', '', 'I reviewed this Short and agree to send its video and audio to my TikTok inbox.'));
        card.append(consentRow);
        const send = element('button', 'ghost', 'Send to TikTok inbox');
        send.type = 'button';
        send.disabled = true;
        consent.addEventListener('change', () => { send.disabled = !tiktokConnected || !eligible || !consent.checked; });
        send.addEventListener('click', async () => {
          send.disabled = true;
          send.textContent = 'Preparing TikTok video…';
          try {
            await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-inbox`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ consent: consent.checked })
            });
            showNotice('Preparing your Short for TikTok. Check status shortly, then finish posting from your TikTok inbox.');
            await loadDrafts();
          } catch (error) {
            showNotice(error.message, true);
            send.textContent = 'Send to TikTok inbox';
            send.disabled = !tiktokConnected || !eligible || !consent.checked;
          }
        });
        card.append(send);
      }
    } else if (status !== 'published') {
      const refresh = element('button', 'ghost', 'Check TikTok status');
      refresh.type = 'button';
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          const result = await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-status`);
          showNotice(result.status === 'ready_in_tiktok_inbox'
            ? 'TikTok delivered the clip. Open your TikTok inbox to edit and post it.'
            : `TikTok: ${result.status.replaceAll('_', ' ')}`);
          await loadDrafts();
        } catch (error) { showNotice(error.message, true); refresh.disabled = false; }
      });
      card.append(refresh);
    }
  }

  if (draft.status === 'awaiting_owner_approval') {
    const actions = element('div', 'draft-actions');
    const publish = element('button', 'publish', 'Publish now');
    publish.type = 'button';
    publish.addEventListener('click', () => {
      if (window.confirm(`Publish this ${isHighlight ? 'highlight video' : 'Short'} publicly now?`)) approveDraft(draft.id, null, publish);
    });

    const scheduleRow = element('div', 'schedule-row');
    const scheduleTime = document.createElement('input');
    scheduleTime.type = 'datetime-local';
    scheduleTime.setAttribute('aria-label', 'Schedule date and time');
    scheduleTime.min = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 16);
    const schedule = element('button', 'ghost', 'Schedule');
    schedule.type = 'button';
    schedule.addEventListener('click', () => {
      if (!scheduleTime.value) return showNotice('Choose a future date and time first.', true);
      const date = new Date(scheduleTime.value);
      if (Number.isNaN(date.getTime()) || date <= new Date()) return showNotice('Choose a valid future time.', true);
      approveDraft(draft.id, date.toISOString(), schedule);
    });
    scheduleRow.append(scheduleTime, schedule);
    actions.append(publish, scheduleRow);
    card.append(actions);
  }

  if (draft.status === 'clip_failed' || (isHighlight && draft.error)) {
    const retry = element('button', 'ghost', 'Retry processing');
    retry.type = 'button';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      try {
        await api(`/api/drafts/${encodeURIComponent(draft.id)}/retry`, { method: 'POST' });
        showNotice('Highlight job queued again.');
        await loadDrafts();
      } catch (error) {
        showNotice(error.message, true);
        retry.disabled = false;
        retry.textContent = 'Retry processing';
      }
    });
    card.append(retry);
  }
  return card;
}

function seoHeading(label, value) {
  const section = element('div', 'seo-field');
  section.append(element('h4', '', label), element('p', 'seo-copy', value));
  return section;
}

function renderSeoVideo(item) {
  const card = element('article', 'draft');
  const top = element('div', 'draft-top');
  top.append(element('h3', '', item.source.title || item.videoId),
    element('span', 'draft-status', item.status.replaceAll('_', ' ')));
  card.append(top);
  const link = element('a', 'ghost video-link', 'Open on YouTube');
  link.href = `https://youtu.be/${encodeURIComponent(item.videoId)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  card.append(link);
  if (item.error) card.append(element('p', 'draft-error', item.error));
  card.append(element('p', 'draft-meta', `YouTube visibility: ${item.source.privacyStatus || 'unknown'}`));
  if (item.applied) card.append(element('p', 'draft-meta',
    `SEO applied to this video on ${new Date(item.applied.at).toLocaleString()}.`));
  if (item.autoResult?.state === 'skipped') card.append(element('p', 'draft-meta',
    `Automatic SEO skipped: ${item.autoResult.reason}`));
  if (item.autoResult?.state === 'retry') card.append(element('p', 'draft-meta',
    `Automatic SEO will retry: ${item.autoResult.reason}`));
  if (item.audit?.length) card.append(seoHeading('Current SEO findings', item.audit.join('\n')));

  const details = document.createElement('details');
  details.className = 'seo-details';
  details.append(element('summary', '', item.package ? 'Inspect package or add context' : 'Add video context'));
  if (item.package) {
    const pkg = item.package;
    details.append(seoHeading('Primary keyword', pkg.primaryKeyword));
    for (const group of ['search', 'curiosity', 'hybrid']) {
      details.append(seoHeading(`${group[0].toUpperCase() + group.slice(1)} titles`,
        (pkg.titles?.[group] || []).map((title, index) => `${index + 1}. ${title}`).join('\n')));
    }
    (pkg.thumbnails || []).forEach((brief, index) => {
      details.append(seoHeading(`Thumbnail ${index + 1}`,
        `${brief.overlay}\nVisual: ${brief.visual}\nPalette: ${brief.palette}\nHook: ${brief.hook}`));
    });
    details.append(seoHeading('Full description', pkg.description || ''));
    details.append(seoHeading('Tags', (pkg.tags || []).join(', ')));
    details.append(seoHeading('Pinned comment', pkg.pinnedComment || ''));
    details.append(seoHeading('Community post', pkg.communityPost || ''));
    details.append(seoHeading('Shorts clips', (pkg.shorts || []).map((clip) =>
      `${clip.start}–${clip.end}: ${clip.title} — ${clip.hook}`).join('\n') || 'Add verified clip windows.'));
    if (pkg.missingEvidence?.length) {
      details.append(seoHeading('Evidence gaps', pkg.missingEvidence.join('\n')));
    }
    const copy = element('button', 'ghost', 'Copy complete package');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(pkg, null, 2)); showNotice('SEO package copied.'); }
      catch { showNotice('Clipboard unavailable on this device.', true); }
    });
    details.append(copy);
  }
  if (item.analysis) {
    const analysis = item.analysis;
    details.append(seoHeading('Video analysis (AI suggestions; review before using)', [
      analysis.summary,
      analysis.spokenSummary ? `Audio: ${analysis.spokenSummary}` : 'No clear speech summary',
      analysis.visualContext ? `Visuals: ${analysis.visualContext}` : '',
      analysis.topics?.length ? `Topics: ${analysis.topics.join(', ')}` : '',
      analysis.speakerTone ? `Tone: ${analysis.speakerTone}` : '',
      analysis.audience ? `Suggested audience: ${analysis.audience}` : '',
      analysis.entities?.length ? `Entities: ${analysis.entities.join(', ')}` : '',
      analysis.primaryKeyword ? `Suggested keyword: ${analysis.primaryKeyword}` : '',
      analysis.secondaryKeywords?.length ? `Related phrases: ${analysis.secondaryKeywords.join(', ')}` : '',
      analysis.category ? `Suggested category: ${analysis.category}` : '',
      analysis.tags?.length ? `Suggested tags: ${analysis.tags.join(', ')}` : '',
      analysis.moments?.length ? `Approximate moments (not chapters): ${analysis.moments.map((moment) =>
        `${moment.time} ${moment.detail}`).join('; ')}` : ''
    ].filter(Boolean).join('\n')));
  }

  const form = element('form', 'seo-context');
  for (const [name, label, multiline] of [
    ['topic', 'Main topic', false], ['primaryKeyword', 'Primary keyword', false],
    ['takeaways', 'Key moments or script', true], ['audience', 'Target audience', false],
    ['videoType', 'Video type', false]
  ]) {
    const field = document.createElement(multiline ? 'textarea' : 'input');
    field.name = name;
    field.value = item.context?.[name] || '';
    if (multiline) field.rows = 3;
    form.append(element('label', '', label), field);
  }
  const markers = document.createElement('textarea');
  markers.name = 'markers';
  markers.rows = 4;
  markers.value = JSON.stringify(item.context?.markers || [], null, 2);
  markers.placeholder = '[{"kind":"chapter","startSeconds":0,"title":"Intro"},{"kind":"clip","startSeconds":120,"endSeconds":155,"title":"Clutch moment"}]';
  form.append(element('label', '', 'Verified chapter and clip markers (JSON)'), markers,
    element('p', 'draft-meta', 'Use seconds from the actual video. Chapters need at least three markers starting at 0, spaced 10 seconds apart.'));
  const save = element('button', 'primary', 'Save context and regenerate');
  save.type = 'submit';
  form.append(save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const fields = Object.fromEntries(new FormData(form));
      fields.markers = JSON.parse(fields.markers);
      await api(`/api/seo/videos/${encodeURIComponent(item.videoId)}/context`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields)
      });
      showNotice('Context saved. A new package is queued.');
      await loadSeo();
    } catch (error) { showNotice(error.message, true); save.disabled = false; }
  });
  details.append(form);
  const regenerate = element('button', 'ghost', 'Retry package without changing context');
  regenerate.type = 'button';
  regenerate.addEventListener('click', async () => {
    regenerate.disabled = true;
    try {
      await api(`/api/seo/videos/${encodeURIComponent(item.videoId)}/regenerate`, { method: 'POST' });
      showNotice('SEO package queued again.');
      await loadSeo();
    } catch (error) { showNotice(error.message, true); regenerate.disabled = false; }
  });
  details.append(regenerate);
  card.append(details);
  return card;
}

async function loadSeo() {
  try {
    const [status, videos] = await Promise.all([
      api('/api/seo/status'), api(`/api/seo/videos?offset=${seoOffset}`)
    ]);
    seoEnabled = status.enabled !== false;
    const counts = status.statuses || {};
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    seoStatus.textContent = [
      status.channelTitle ? `Connected channel: ${status.channelTitle}` : 'Waiting for channel connection',
      `${total} videos found; ${counts.ready || 0} ready, ${counts.needs_review || 0} have evidence gaps, ${counts.queued || 0} queued`,
      `${status.appliedTotal || 0} public videos updated by Amaana`,
      status.completed ? 'Catalog scan complete' : 'Catalog scan in progress',
      status.providerConfigured ? `${status.attemptedToday}/${status.dailyLimit} AI attempts today (UTC)`
        : 'Configure SEO_AI_API_KEY and SEO_AI_MODEL to create packages',
      status.videoAnalysisEnabled ? 'Video analysis on for public videos' : 'Video analysis off',
      status.providerError ? `${status.providerError}; next retry after ${new Date(status.providerBlockedUntil).toLocaleString()}` : null,
      status.autoPublishEnabled ? 'Automatic public video SEO on' : 'Automatic publishing disabled',
      seoEnabled ? 'SEO jobs active' : 'SEO jobs paused'
    ].filter(Boolean).join(' · ');
    seoToggle.textContent = seoEnabled ? 'Pause SEO jobs' : 'Resume SEO jobs';
    seoList.replaceChildren(...(videos.length ? videos.map(renderSeoVideo) :
      [element('div', 'empty-state', 'No channel videos in this page yet. Refresh after the next catalog scan.')]));
    seoPage.textContent = `${total ? seoOffset + 1 : 0}–${Math.min(total, seoOffset + videos.length)} of ${total}`;
    seoPrevious.disabled = seoOffset === 0;
    seoNext.disabled = seoOffset + videos.length >= total;
  } catch (error) {
    if (error.status === 401) return showLogin();
    seoStatus.textContent = error.message;
  }
}

async function loadChannelSeo() {
  try {
    const channel = await api('/api/seo/channel');
    seoChannel.replaceChildren(
      element('p', 'draft-meta', `${channel.title} · ${channel.id}`),
      element('p', '', `Description: ${channel.description || '(empty)'}`),
      element('p', '', `Keywords: ${channel.keywords || '(empty)'}`),
      element('p', 'draft-meta', channel.audit?.length
        ? `Findings: ${channel.audit.join(' ')}`
        : 'Channel description and keywords are present.')
    );
  } catch (error) {
    if (error.status === 401) return showLogin();
    seoChannel.textContent = error.message;
  }
}

async function loadDrafts() {
  try {
    const drafts = await api('/api/drafts');
    draftList.replaceChildren();
    if (!drafts.length) {
      draftList.append(element('div', 'empty-state', 'No drafts yet. Upload a Short above or let your agent create one.'));
      return;
    }
    drafts.forEach((draft) => draftList.append(renderDraft(draft)));
  } catch (error) {
    if (error.status === 401) return showLogin();
    draftList.replaceChildren(element('div', 'empty-state', error.message));
  }
}

async function refreshDashboard() {
  try {
    await Promise.all([refreshConnection(), refreshTwitchConnection(), refreshTikTokConnection()]);
    await loadDrafts();
    await loadSeo();
    await loadChannelSeo();
  } catch (error) {
    if (error.status === 401) return showLogin();
    showNotice(error.message, true);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();
  const button = loginForm.querySelector('button');
  button.disabled = true;
  button.textContent = 'Unlocking…';
  try {
    await api('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: document.querySelector('#adminKey').value })
    });
    loginForm.reset();
    showDashboard();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock dashboard';
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();
  uploadButton.disabled = true;
  uploadButton.textContent = 'Uploading privately…';
  try {
    const form = new FormData(uploadForm);
    form.set('madeForKids', document.querySelector('#madeForKids').checked ? 'true' : 'false');
    await api('/api/drafts', { method: 'POST', body: form });
    uploadForm.reset();
    showNotice('Private Short uploaded. Review it in the approval queue.');
    await loadDrafts();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = 'Upload as private draft';
  }
});

connectButton.addEventListener('click', () => window.location.assign('/auth/google'));
twitchConnectButton.addEventListener('click', () => window.location.assign('/auth/twitch'));
tiktokConnectButton.addEventListener('click', () => window.location.assign('/auth/tiktok'));
document.querySelector('#refreshButton').addEventListener('click', refreshDashboard);
document.querySelector('#seoRefresh').addEventListener('click', () => {
  loadSeo(); loadChannelSeo();
});
seoToggle.addEventListener('click', async () => {
  seoToggle.disabled = true;
  try {
    await api('/api/seo/backfill', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !seoEnabled }) });
    await loadSeo();
  } catch (error) { showNotice(error.message, true); } finally { seoToggle.disabled = false; }
});
document.querySelector('#seoRescan').addEventListener('click', async () => {
  try {
    await api('/api/seo/backfill', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, restart: true }) });
    showNotice('Channel rescan started; existing packages are preserved.');
    await loadSeo();
  } catch (error) { showNotice(error.message, true); }
});
seoPrevious.addEventListener('click', () => { seoOffset = Math.max(0, seoOffset - 50); loadSeo(); });
seoNext.addEventListener('click', () => { seoOffset += 50; loadSeo(); });
document.querySelector('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});

(async () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('youtube') === 'connected') {
    history.replaceState({}, '', '/');
    showNotice('YouTube connected successfully.');
  }
  if (params.get('twitch') === 'connected') {
    history.replaceState({}, '', '/');
    showNotice('Twitch connected successfully. AI-detected VOD highlights can now become private Short drafts.');
  }
  if (params.get('tiktok') === 'connected') {
    history.replaceState({}, '', '/');
    showNotice('TikTok connected. Review a Short to send it to your TikTok inbox.');
  }
  try {
    const session = await api('/api/admin/session');
    if (session.authenticated) showDashboard();
    else showLogin();
  } catch (error) {
    showLogin();
    showNotice(error.message, true);
  }
})();
