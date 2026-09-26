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
const draftList = document.querySelector('#draftList');
const uploadButton = document.querySelector('#uploadButton');
let draftPoll = null;

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
    await Promise.all([refreshConnection(), refreshTwitchConnection(), loadDrafts()]);
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
document.querySelector('#refreshButton').addEventListener('click', refreshDashboard);
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
  try {
    const session = await api('/api/admin/session');
    if (session.authenticated) showDashboard();
    else showLogin();
  } catch (error) {
    showLogin();
    showNotice(error.message, true);
  }
})();
