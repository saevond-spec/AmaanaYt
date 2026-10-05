# AmaanaYt

YouTube Shorts, TikTok inbox, and video SEO service for **@saevond**.

AmaanaYt connects to YouTube and Twitch with OAuth. After SweatyClanker detects moments in an ended Twitch stream, Amaana checks candidate timestamps against the archive duration, creates the Twitch clips, then rechecks Twitch's returned VOD offsets and clip lengths. Twitch's VOD API supplies archive duration; its clip metadata exposes the created clip's VOD position for the recheck ([Get Videos](https://dev.twitch.tv/docs/api/videos), [API reference](https://dev.twitch.tv/docs/api/reference)). It assembles a landscape highlight and vertical Shorts, probes the rendered dimensions and durations, applies a thumbnail, and registers each output for SEO processing.

New highlight batches upload as private first. With `HIGHLIGHT_AUTO_PUBLISH` enabled (the default), Amaana publishes the parent video and every Short only after all media checks, the thumbnail, SEO registration, and YouTube processing checks pass. A transient failure retries from saved IDs; a permanent error returns the batch to owner review. Existing private and unlisted videos are never promoted by this flow. Batches created before the automatic-publish patch remain private for owner review. SweatyClanker still supplies candidate timestamps; Amaana validates timestamp accuracy against Twitch metadata but does not itself watch or interpret VOD footage.

Generated Shorts can also be sent to the creator's TikTok inbox **one at a time after the creator previews and consents to each transfer**. The creator edits and completes each post in the TikTok app. TikTok delivery does not happen automatically at stream end.

Amaana can list and create the channel's YouTube playlists and automatically place confident metadata matches from the existing public, private, and unlisted catalog. New drafts and private/unlisted catalog videos can only go into private playlists; public videos prefer a matching public playlist. Adding a playlist item never changes video visibility.

Playlist matching considers video titles, existing tags, owner topic fields, and generated SEO package tags. When Amaana applies SEO to an eligible public video, the generated focused tags come first; existing tags are retained afterward where the app's 30-tag and conservative 450-character safeguards allow. YouTube says tags are mainly useful for common misspellings, while search relevance centers on the title, description, and video content. Use playlists to group related formats or series, then compare those groups in Analytics over the same time window; tags and playlist placement do not guarantee discovery ([tag guidance](https://support.google.com/youtube/answer/141805), [description tips](https://support.google.com/youtube/answer/12948449), [playlist/content group guidance](https://support.google.com/youtube/answer/13616340)).

## Five-year capacity simulation

Run `npm run simulate:five-years` to estimate pipeline volume, SEO analysis backlog, safe write throughput, and YouTube API quota use over five years. The default scenario assumes one six-hour Twitch VOD per day, three selected moments per VOD, and a 1,000-video public-library stress cohort with 30% missing analysis. These are adjustable load-test assumptions, not channel measurements.

The simulator forecasts operational capacity only; it does not predict views, revenue, or ranking. Quota values follow the [YouTube API quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost). It includes the separate 100-per-day YouTube `videos.insert` and `search.list` request buckets, then accounts for a 1-unit pre-publish `videos.list` and 50-unit `videos.update` for each generated video. Set `SIM_START_DATE`, `SIM_STREAMS_PER_DAY`, `SIM_HOURS_PER_STREAM`, `SIM_MOMENTS_PER_STREAM`, `SIM_PUBLIC_VIDEO_COHORT`, and `SIM_MISSING_ANALYSIS_SHARE` to model another scenario. Actual project quota can differ.

## Thumbnail ratings and two-year simulation

Amaana rates the three generated thumbnail concepts for exact phrase support in video evidence, short readable overlay text, grounded topic fit, title complement, and the renderer's fixed white-text/dark-backing/yellow-accent treatment. It selects the highest-scoring grounded concept at or above 60/100; otherwise it uses a safe title-derived fallback or skips the thumbnail. This is a text-brief heuristic: it does not inspect image pixels, source quality, or layout, and it does not predict CTR, views, watch time, or revenue.

YouTube recommends accurate titles and thumbnails, simple designs, and readable text. Its desktop Studio Test & Compare feature can test up to three thumbnail variants, title variants, or combinations and chooses a winner by watch-time share. A test usually takes a few days and can take up to two weeks. It is unavailable for Shorts, scheduled live streams, Premieres, private videos, made-for-kids videos, and age-restricted videos. Amaana does not launch or read Studio experiments; use those tests on eligible videos for performance evidence ([YouTube thumbnail and title tips](https://support.google.com/youtube/answer/12340300), [Test & Compare](https://support.google.com/youtube/answer/16391400)).

YouTube recommends 3840×2160 thumbnails for standard videos, with a 16:9 aspect ratio and a minimum width of 640 pixels. The YouTube Data API now exposes `fhd` (1920×1080), `qhd` (2560×1440), and `uhd` (3840×2160) thumbnail variants for some videos. Amaana selects the largest API-provided variant and keeps its source detail through composition, capped at 4K. For Twitch highlight batches, it extracts the frame from the selected original downloaded clip before the highlight montage is normalized to 1280×720. Smaller sources stay at their available size (with only the platform minimum applied); the renderer does not enlarge them to 4K and claim extra detail ([custom thumbnail requirements](https://support.google.com/youtube/answer/72431), [YouTube video resource thumbnail variants](https://developers.google.com/youtube/v3/docs/videos), [September 2026 API updates](https://developers.google.com/youtube/v3/revision_history)).

Run `npm run simulate:two-years` for a 730-day capacity and recovery simulation. Defaults model 1,000 public videos in the starting queue, one new public video per day, three concepts per video, a 50-video daily processing cap, and one synthetic thumbnail rate limit per 37 videos. Private and unlisted cohorts are excluded. These are test assumptions, not channel or view forecasts.

If YouTube requests begin failing with `invalid_grant`, the saved refresh token may be expired or invalidated; reconnect YouTube from the owner dashboard. Google also documents seven-day refresh-token expiration when an external OAuth consent screen remains in Testing and requests non-basic scopes. Amaana waits five minutes before retrying a failed automatic market refresh so a health check cannot trigger another attempt every few seconds. This cooldown limits retries; it does not restore authorization ([Google OAuth refresh-token guidance](https://developers.google.com/identity/protocols/oauth2#expiration)).

## Security model

- Google passwords are never collected.
- OAuth credentials and refresh tokens are never committed to GitHub.
- YouTube and Twitch tokens are encrypted with AES-256-GCM before database storage.
- TikTok access and refresh tokens use the same encrypted database storage.
- `AGENT_KEY` can submit Twitch highlight jobs. Those new jobs may publish after the configured quality gate; it cannot publish or change visibility on existing catalog videos.
- `ADMIN_KEY` controls OAuth connection, draft review, publication, and scheduling.
- New uploads always start as private.
- TikTok delivery requires owner approval per Short. TikTok media URLs are signed and expire.
- Amaana automatically applies evidence-backed SEO titles, descriptions, and tags to eligible **public videos only** on the connected channel. Existing private, unlisted, and unpublished videos are skipped by automatic SEO updates. Video visibility is never included in update requests. Public videos require video analysis or owner takeaways. Amaana preserves existing description text, links, and disclosures, and skips videos when evidence or metadata checks fail.
- Amaana updates channel keywords from analyzed public uploads and fills an empty channel description with a brief, topic-grounded description. It does not post comments or Community posts.
- The service does not delete existing videos.

Keep `ADMIN_KEY` out of OpenClaw. Give OpenClaw only `AGENT_KEY`.

## Free deployment architecture

- Render Free web service runs the Node.js application.
- A free external PostgreSQL project stores encrypted OAuth tokens and draft records.
- Temporary video files use `/tmp/uploads` and are deleted after upload.
- No Render persistent disk or payment method is required.

Render Free can sleep when idle, so the first request after inactivity may take about a minute. The external database preserves the YouTube connection across Render restarts.

## 1. Create the free database

Create a free PostgreSQL project, for example at [Supabase](https://supabase.com/).

In Supabase:

1. Create a new project and save its database password.
2. Open **Connect**.
3. Select the **Session pooler** connection string. This is generally the safest choice for an IPv4 hosting service.
4. Copy the URI connection string.
5. Replace the password placeholder with the database password.
6. Append `?sslmode=verify-full` to the URI (or `&sslmode=verify-full` if it already has query parameters). Replace any existing `sslmode` value. Save the complete URI as `DATABASE_URL` in Render.

It resembles:

`postgresql://postgres.PROJECT:PASSWORD@POOLER-HOST:5432/postgres?sslmode=verify-full`

Treat this URL as a secret. Never commit or post it publicly. TLS certificate and hostname verification is enabled in production. Older deployed `sslmode=require` URLs are interpreted as `verify-full` at runtime to avoid the pg compatibility warning; update the actual Render variable too. If the server uses a self-signed certificate, install its trusted CA rather than disabling verification. AmaanaYt creates its required tables automatically.

## 2. Deploy the Render Blueprint

1. Sign in at [Render](https://dashboard.render.com/) using GitHub.
2. Choose **New → Blueprint**.
3. Connect `saevond-spec/AmaanaYt`.
4. Use branch `main` and the root `render.yaml`.
5. Confirm that the service plan says **Free**.
6. Supply the environment variables requested by Render.
7. Deploy the Blueprint.

Required values:

- `BASE_URL`: exact Render HTTPS origin, with no trailing slash
- `DATABASE_URL`: external PostgreSQL session-pooler URI with `sslmode=verify-full`
- `GOOGLE_CLIENT_ID`: Google OAuth web client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `TWITCH_CLIENT_ID`: client ID for a dedicated Twitch application
- `TWITCH_CLIENT_SECRET`: secret for that Twitch application
- `TOKEN_ENCRYPTION_KEY`: exactly 64 hexadecimal characters
- `AGENT_KEY`: long random key for workflow requests and private uploads
- `ADMIN_KEY`: different owner-only secret

`HIGHLIGHT_AUTO_PUBLISH` defaults to `true` for new, quality-checked Twitch highlight batches. Set it to `false` to keep new highlight videos and Shorts private for owner review. This switch does not affect any existing private or unlisted video.

Transient production and YouTube-processing failures retry up to 12 times by default, with exponential backoff capped at 30 minutes. Set `HIGHLIGHT_MAX_AUTO_ATTEMPTS` to a positive integer from 1 to 24 to change the limit. Permanent processing or permission errors stop for owner review.

Render generates `SESSION_SECRET`.

Optional `REDIS_URL` enables Redis-backed sessions (`redis://` or `rediss://`). With no URL, or if Redis cannot connect during startup, sessions use the existing PostgreSQL pool and an automatically created `amaana_sessions` table. This avoids the production MemoryStore warning. Switching stores requires signing in again; keep `SESSION_SECRET` stable across redeploys.

For TikTok inbox delivery, also configure `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, and the URL verification values described below.

For SEO package generation with OpenAI, set `SEO_AI_API_KEY` to a project API key in Render, `SEO_AI_MODEL` to `gpt-5-mini`, and `SEO_AI_BASE_URL` to `https://api.openai.com/v1`. The code defaults to that OpenAI URL when the base URL is unset. `SEO_AI_TIMEOUT_MS` defaults to 120000 milliseconds per model request. `SEO_DAILY_LIMIT` defaults to 200 generation attempts per UTC day; one run can use the full remaining budget. Package generation sends each video's title, description, tags, and any owner-entered notes to the OpenAI API; API usage has its own billing. Without the key or model Amaana scans the catalog and queues packages but makes no model requests. Do not paste an API key into the repository, a chat message, or a public page.

On HTTP 503, alternate models are tried with 1, 5, and 15 second delays plus up to 1 second of jitter; three consecutive 503s open that model's in-process circuit for 30 minutes. The queue pauses for 30, 60, then 120 minutes on successive 503 failures (maximum 120 minutes). On HTTP 429, a model request retries once after `Retry-After` (default 60 seconds) when the delay is at most one minute. If it still fails, the queue uses a valid `Retry-After` header for its pause, or pauses for 60 minutes when the header is absent or invalid. Longer headers pause the queue immediately without holding a request open.

Video analysis is enabled in the Render blueprint and off in the local example. Automatic publication requires video analysis or owner-entered takeaways; without either, Amaana skips the public video and shows the reason in the dashboard. Older public packages without footage analysis are requeued one at a time after six hours when the provider is available. For a Gemini SEO base URL, Amaana reuses `SEO_AI_API_KEY`; for an OpenAI SEO base URL, provide a separate Gemini key as `VIDEO_ANALYSIS_API_KEY`. `VIDEO_ANALYSIS_MODEL` defaults to the configured Gemini SEO model, or `gemini-3.8-flash` with a separate key. `VIDEO_ANALYSIS_TIMEOUT_MS` defaults to 180000 milliseconds. No extra npm dependency is needed: this feature uses the existing HTTPS request path.

Generate independent secrets with:

```bash
openssl rand -hex 32
```

Run it three times for `TOKEN_ENCRYPTION_KEY`, `AGENT_KEY`, and `ADMIN_KEY`.

## 3. Google Cloud setup

1. Create a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the Google Auth consent screen.
4. Create an OAuth client of type **Web application**.
5. Add the exact authorized redirect URI:
   `https://YOUR-RENDER-DOMAIN/oauth2/callback`
6. Store the client ID and secret only in Render.

The app requests:

`https://www.googleapis.com/auth/youtube.upload`

`https://www.googleapis.com/auth/youtube.force-ssl` (required by YouTube for the owner approval and scheduling actions; reconnect YouTube after upgrading an existing installation)

## 4. Twitch developer setup

1. Open the Twitch Developer Console and register a dedicated application for Amaana.
2. Add this exact OAuth redirect URL:
   `https://YOUR-RENDER-DOMAIN/oauth/twitch/callback`
3. Copy the Client ID and generate a Client Secret.
4. Store them only in Render as `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.
5. Redeploy Amaana, open the dashboard, and tap **Connect Twitch**.
6. Sign in with the Twitch account that owns the Saevond channel and approve `channel:manage:clips`.

In Twitch **Creator Dashboard → Settings → Stream → VOD Settings**, enable **Store past broadcasts**. Automatic post-stream clipping cannot work if Twitch never creates the archive VOD.

## TikTok developer setup

1. Register an app with TikTok for Developers. Enable Login Kit for Web and Content Posting API, and obtain the approved `user.info.basic` and `video.upload` scopes.
2. Register this exact Login Kit redirect URI: `https://YOUR-RENDER-DOMAIN/oauth/tiktok/callback`.
3. In TikTok's **URL properties** for this app, verify the URL prefix `https://YOUR-RENDER-DOMAIN/tiktok-media/`. TikTok gives you a signature file: put its filename in `TIKTOK_VERIFICATION_FILENAME` and its exact contents in `TIKTOK_VERIFICATION_CONTENT` in Render, then verify the file at `https://YOUR-RENDER-DOMAIN/tiktok-media/YOUR-FILENAME` before clicking Verify in TikTok. TikTok must be able to pull HTTPS MP4 files under that prefix without redirects. Amaana serves a newly generated file after the owner requests a transfer; it is not a permanent media archive.
4. Store the app's client key and client secret as `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` in Amaana's Render environment. Keep the secret out of GitHub and chat.
5. Redeploy Amaana, open the owner dashboard, and choose **Connect TikTok**. Authorize the TikTok account you want to receive your stream Shorts.

After a Short appears in Amaana, open its private YouTube preview and review the audio and footage. For that Short, check the automatic delivery consent box and select **Enable automatic TikTok delivery**. Once the Short is public on YouTube and YouTube reports **more than 2,000 views** (2,001 or higher), Amaana automatically sends it to your TikTok inbox. You can revoke consent before delivery. You can also use **Check YouTube views** and send an eligible Short manually after confirming consent. TikTok will notify the connected creator account: open the inbox notification to edit and publish it. Use **Check TikTok status** in Amaana to see delivery or publication status.

Amaana checks its own generated stream Shorts on startup, while awake, and when the owner dashboard is opened. The hourly GitHub Actions workflow in `.github/workflows/check-short-views.yml` pings the service to wake a sleeping Render Free instance. GitHub's scheduled workflows can run late or be disabled for inactive repositories, so delivery is conditional on a successful check; the owner can always select **Check YouTube views** in the dashboard. Amaana checks each Short again before it sends its media to TikTok, and spaces automatic sends to at most one per 55 minutes and five attempts per 24 hours. Each eligible clip needs its own explicit opt-in. This monitors only Shorts Amaana created from stream highlights, not every Short already on the channel.

TikTok may limit pending inbox shares (its documentation notes at most five within a 24-hour period), and a stopped or restarted free Render instance may lose the temporary media file before TikTok finishes pulling it. If TikTok reports a failed pull, retry the Short from the owner dashboard.

TikTok's Direct Post API for automatic public publication requires an audited app and per-post review and consent in the app. TikTok's published criteria also say an internal utility for just one account is not an acceptable Direct Post app. The TikTok inbox route above lets the creator complete public posting inside TikTok without claiming that the bot can publish public posts unattended.

## 5. Verify deployment

Open:

`https://YOUR-RENDER-DOMAIN/healthz`

Expected response:

```json
{"ok":true,"database":"connected"}
```

## 6. Connect @saevond

Send an authenticated request to:

`GET /auth/google`

using the `x-admin-key` header. Open the returned Google authorization URL, choose the Google account that owns **@saevond**, and approve the upload permission.

## 7. Connect SweatyClanker

On the SweatyClanker Render service, add:

- `CLIP_WEBHOOK_URL=https://YOUR-RENDER-DOMAIN/api/twitch/vod-clips`
- `CLIP_WEBHOOK_KEY`: the same secret stored as Amaana's `VOD_WEBHOOK_KEY`. The existing `AGENT_KEY` also works for older bot setups.
- `HIGHLIGHT_DETECTION_ENABLED=true`

Never paste the webhook key into chat or commit it to GitHub.

## 8. OpenClaw installation

Copy `skills/youtube-manager` into the OpenClaw skills directory and configure:

- `AMAANA_YT_URL`: deployed Render origin
- `AMAANA_YT_AGENT_KEY`: same value as `AGENT_KEY`

Do not give OpenClaw `ADMIN_KEY`.

## API workflow

### Automatic playlists

Amaana compares each video's title, description, tags, and owner-entered topic fields with the titles and descriptions of playlists owned by the connected channel. A confident match is added automatically. If multiple playlists match equally or the metadata is too broad, the video stays unassigned. It does not create playlists automatically; create the right series playlists in the dashboard first.

New private uploads and Twitch highlights are assigned only to private playlists while they remain drafts. Existing public, private, and unlisted catalog videos are classified from YouTube metadata; public videos prefer public playlists, with a matching private or unlisted playlist as a fallback, while private and unlisted videos only use private playlists. Playlist assignment never changes a video's visibility. Creating a playlist makes previously unmatched catalog videos eligible for another pass.

**YOUTUBE_AUTO_PLAYLISTS** defaults to true. **YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT** defaults to 20 assignment attempts per YouTube quota day (midnight Pacific) for public videos and 20 for the combined private/unlisted group; each group is capped at 20. **YOUTUBE_AUTO_PLAYLIST_BATCH_SIZE** defaults to 20 catalog videos per worker pass. Disable automatic placement with **YOUTUBE_AUTO_PLAYLISTS=false**. The five-year simulator includes one playlist-item duplicate check and all 20 possible owned-playlist pages for each assignment, plus the insert unit cost.

### SEO packages for every channel upload

After deployment, Amaana reads the authenticated channel's uploads playlist in pages of up to 50 videos, then fetches the video metadata in batches. It keeps a database cursor, rescans the newest page for future uploads, and resumes the older catalog after restarts. The hourly `/healthz` wake-up also advances this work; on Render Free, sleep and delayed GitHub Actions runs can extend the schedule. The dashboard shows metadata findings, generated packages, automatic results, and skip reasons. You can pause or restart the scan from the owner dashboard; pausing stops automatic SEO publication too. If the connected YouTube channel changes, the scan pauses rather than mixing two channels in one catalog.

If the provider reports insufficient balance (HTTP 402), or OpenAI returns a 429 with a credit, spend, or usage-limit code, Amaana keeps the affected video eligible for retry and pauses generation for two hours while catalog scanning continues. The dashboard shows the provider error and retry time. After restoring credits or resolving the limit, pause and resume SEO jobs from the dashboard to retry sooner. An ordinary 429 rate limit is handled separately from credit exhaustion.

Each package contains three search titles, three curiosity titles, three hybrid titles (each under 60 characters), three thumbnail briefs, a 50–160 character keyword hook, description paragraphs, chapters where validated times exist, resource placeholders, three hashtags, 3–8 focused tags, a pinned comment draft, a community post teaser, and 2–3 clip recommendations when enough source moments exist. Automatic application selects a hybrid title, joins the evidence-backed hook and paragraphs with the existing description, and merges relevant tags. For eligible public videos, Amaana composes a JPEG from the highest-resolution YouTube thumbnail variant available for that video and adds a short overlay grounded in the title, description, tags, or video analysis. Twitch highlight parents use a frame from the selected original clip before montage downscaling. Output dimensions follow the real source up to 3840×2160; the source image is preserved if no supported text or usable image exists. It never sends resource placeholders, unverified chapters, comments, or Community posts. Title and thumbnail concepts stay specific to the footage and favor viewer satisfaction over click-through alone. YouTube's native title and thumbnail experiments judge outcomes by watch-time share; those experiments are not run by Amaana, and Shorts are not eligible for those experiments ([YouTube guidance](https://support.google.com/youtube/answer/16391400)). No SEO result or AI summary appearance is guaranteed.

Amaana can sample recent public YouTube gameplay videos for ARC Raiders, NARAKA: BLADEPOINT, and other recognized games. The sample is cached for 24 hours, capped at three searches per UTC day, and shown to the owner at `GET /api/seo/market?game=ARC%20Raiders`. Each sample includes total public views and an age-adjusted estimated views/day value using a one-day age floor; this is rough view velocity, not a search-volume estimate, forecast, or evidence that an event happened in your footage. The generated copy stays grounded in the video's own analysis or owner notes. `SEO_MARKET_RESEARCH=false` disables these searches.

For eligible public upcoming or active YouTube broadcasts, `YOUTUBE_PUBLIC_LIVE_MONETIZATION=true` makes Amaana check the connected `@saevond` account and enable ads through the Live Streaming API. It verifies ownership, public visibility, YouTube's ads eligibility flag, and the current broadcast version before writing only monetization settings; `/api/monetization/status` shows the most recent scan. A channel must already qualify for YouTube Partner Program ads and accept the relevant terms. Existing uploaded video ad toggles and revenue-module terms are managed in YouTube Studio; Amaana's video SEO updates do not alter them. The wake-up workflow checks approximately every 15 minutes, subject to GitHub Actions and Render timing.

Amaana accepts verified chapter and clip markers as seconds from the final video, including the offsets it measures when assembling Twitch highlights. For older videos it can reuse chapter lines already present in a description. It never guesses timestamps from a title. A video without enough markers gets an evidence warning in its package; automatic application omits generated chapters and preserves existing description text. Chapter sequences require at least three positions starting at zero, with chapters at least ten seconds long.

When enabled, Amaana asks Gemini to analyze each **public** video before drafting its SEO package. The returned topic, audio, visual, keyword, and audience suggestions are stored once per video in PostgreSQL and shown in the dashboard. Owner-entered context remains authoritative. Model-suggested moments are labeled approximate and are never used as verified chapters or Shorts windows. If analysis fails, a public video remains eligible for retry or owner review. Private and unlisted videos are never analyzed from their YouTube video URL and are excluded from automatic metadata writes. Gemini's direct YouTube URL input is a preview feature restricted to public videos; the free tier currently permits up to eight hours of YouTube video input per day. See [Google's video understanding documentation](https://ai.google.dev/gemini-api/docs/video-understanding).

Add the topic, primary keyword, script or key takeaways, audience, and video type in the owner dashboard for a stronger package. To specify exact moments, open the video's **Review package and edit context** panel and enter JSON markers such as:

```json
[
  {"kind":"chapter","startSeconds":0,"title":"Opening"},
  {"kind":"chapter","startSeconds":42,"title":"First round"},
  {"kind":"chapter","startSeconds":93,"title":"Final fight"},
  {"kind":"clip","startSeconds":96,"endSeconds":132,"title":"Final fight"},
  {"kind":"clip","startSeconds":145,"endSeconds":175,"title":"Reaction"}
]
```

Saving context queues a replacement package. SEO status and catalog APIs require the owner session or `x-admin-key`: `GET /api/seo/status`, `GET /api/seo/channel`, `GET /api/seo/videos?offset=0`, `PUT /api/seo/videos/{videoId}/context`, `POST /api/seo/videos/{videoId}/regenerate`, and `POST /api/seo/backfill` with `{"enabled":true}` or `{"enabled":true,"restart":true}`. Pausing with `{"enabled":false}` pauses generation and automatic publication. Automatic publishing requires the explicit owner-approved `SEO_AUTO_PUBLISH=true` setting in `render.yaml`; removing it or setting it to `false` stops automatic SEO and thumbnail writes. `SEO_AUTO_DAILY_LIMIT` caps the number of public videos Amaana can update per UTC day at 50 by default; a metadata and thumbnail pair uses two YouTube write calls. New private uploads from the dashboard and Twitch jobs enter the SEO queue but are not automatically edited. Existing private, unlisted, and unpublished videos are skipped. Before every automatic write, the publisher rechecks that the connected channel owns the video and its visibility is still public. Active or upcoming broadcasts wait until they end before an SEO write is attempted again.

For a one-time owner-approved resume of a paused SEO catalog, set a new nonempty `SEO_OWNER_APPROVAL_ID` on the service. The worker stores that marker and enables the catalog once. A later dashboard pause stays paused, even while the setting remains present.

### Queue AI-selected Twitch VOD moments

```bash
curl -X POST "$AMAANA_YT_URL/api/twitch/vod-clips" \
  -H "content-type: application/json" \
  -H "x-agent-key: $AMAANA_YT_AGENT_KEY" \
  -d '{"vodId":"1234567890","channel":"saevond","timestamps":[{"startSeconds":90,"endSeconds":125,"title":"The comeback was unreal","reason":"Strong clutch reaction","score":91}]}'
```

Amaana accepts up to eight moments per VOD. It creates official Twitch clips (each at most 60 seconds), joins them in time order into one landscape highlight video, then cuts a 9:16 Short from each segment of that video. The maximum assembled length is about eight minutes, depending on the moments found. The YouTube highlight and Shorts are private drafts until the owner approves each one. Processing starts after the stream ends and the archive is available; a continuous 24/7 stream does not produce an end event. Creating source clips on Twitch may make those Twitch clips visible independently of the private YouTube drafts.

The VOD detector remains an external prerequisite: it must send the actual VOD ID and grounded timestamps to this endpoint. Amaana does not invent timestamps or discover highlight moments by itself. A batch is marked ready for owner review only after the private highlight, its Shorts, the generated and applied thumbnail, and SEO queue registration all succeed. Partial output stays private and shows a retry action. Transient HTTP 408/425/429/5xx and common network failures retry automatically with bounded backoff (up to four attempts); permanent permission failures need an owner retry. SEO text remains in its owner review flow, and no pipeline step changes an existing video's visibility.

### Upload a private Short

```bash
curl -X POST "$AMAANA_YT_URL/api/drafts" \
  -H "x-agent-key: $AMAANA_YT_AGENT_KEY" \
  -F "video=@/absolute/path/to/short.mp4" \
  -F "title=Your title" \
  -F "description=Your description" \
  -F "tags=NARAKA BLADEPOINT,gaming,shorts" \
  -F "madeForKids=false"
```

### Review drafts

```bash
curl "$AMAANA_YT_URL/api/drafts" -H "x-admin-key: YOUR_ADMIN_KEY"
```

### Publish now

```bash
curl -X POST "$AMAANA_YT_URL/api/drafts/DRAFT_ID/approve" \
  -H "content-type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{}'
```

### Schedule

```bash
curl -X POST "$AMAANA_YT_URL/api/drafts/DRAFT_ID/approve" \
  -H "content-type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"publishAt":"2026-09-20T18:00:00-04:00"}'
```

## Auto dubbing and spoken-audio language

YouTube automatically generates dubs for eligible videos, and channel settings decide how those tracks are published. The public YouTube Data API returns `snippet.defaultAudioLanguage` when available, but its documented `videos.insert` and `videos.update` writable fields do not include that property. It also does not expose generated audio-track status or channel auto-dubbing settings. Amaana therefore reads the spoken-audio language as read-only and links each catalog item to its YouTube Studio Languages page.

Use **YouTube Studio → Languages** to verify generated tracks, publication status, and the manual-review queue. Channel-wide auto-dubbing and publication behavior are managed in **Settings → Channel → Advanced settings**. With automatic dubbing enabled and manual review limited to experimental languages, eligible non-experimental dubs can publish automatically while experimental-language dubs wait for review. YouTube may skip videos over 120 minutes, videos with little or no speech, unsupported or undetected source languages, or speech that is too fast. If the source language is wrong, correct it in Studio so YouTube can regenerate the dubs. See [YouTube automatic dubbing help](https://support.google.com/youtube/answer/15569972), the [videos.insert API](https://developers.google.com/youtube/v3/docs/videos/insert), and [videos.update API](https://developers.google.com/youtube/v3/docs/videos/update).

Market research: YouTube says auto dubbing supports 27 languages and reported more than six million daily viewers watching at least ten minutes of auto-dubbed content in December 2025 ([YouTube auto dubbing update](https://blog.youtube/news-and-events/youtube-auto-dubbing-expressive-speech/)). Creators who added multi-language audio tracks saw more than 25% of watch time from views in a non-primary language on average (July 2025 data); that figure concerns creator-uploaded tracks rather than auto dubs ([multi-language audio data](https://blog.youtube/news-and-events/multi-language-audio/)). Focus initial review on the channel's priority languages (Japanese, Korean, Spanish, Brazilian Portuguese, and French), then use Studio's audio-language analytics to decide where to expand.

## Shorts requirements

Use square or vertical video no longer than three minutes. For gameplay, 1080×1920 (9:16) is recommended. Confirm music and footage rights before uploading.

New Google API projects can be limited to private API uploads until Google completes an API compliance audit. Private drafts will still work, but public automation may require that audit.
