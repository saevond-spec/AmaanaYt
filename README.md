# AmaanaYt

Approval-based YouTube Shorts, TikTok inbox, and video SEO drafting service for **@saevond**.

AmaanaYt connects to YouTube and Twitch with OAuth. After SweatyClanker detects moments in an ended Twitch stream, Amaana assembles them into a landscape highlight video, then cuts vertical Shorts from that assembled video. The highlight and each Short become separate private YouTube drafts; an owner key is required to publish or schedule each one.

For new Twitch highlight batches, Amaana derives moment timestamps from FFmpeg-measured clip durations. When there are at least three segments and each is at least 10 seconds, it adds YouTube chapter timestamps starting at 0:00; otherwise it adds clickable timestamps without calling them chapters. Amaana also creates a 16:9, high-contrast thumbnail from an actual highlight frame and applies it to the private landscape video. Shorts and all uploads remain private until owner approval.

Generated Shorts can also be sent to the creator's TikTok inbox **one at a time after the creator previews and consents to each transfer**. The creator edits and completes each post in the TikTok app. TikTok delivery does not happen automatically at stream end.

Amaana can list and create the channel's YouTube playlists and automatically place confident metadata matches from the existing public, private, and unlisted catalog. New drafts and private/unlisted catalog videos can only go into private playlists; public videos prefer a matching public playlist. Adding a playlist item never changes video visibility.

## Five-year capacity simulation

Run `npm run simulate:five-years` to estimate pipeline volume, SEO analysis backlog, safe write throughput, and YouTube API quota use over five years. The default scenario assumes one six-hour Twitch VOD per day, three selected moments per VOD, and a 1,000-video public-library stress cohort with 30% missing analysis. These are adjustable load-test assumptions, not channel measurements.

The simulator forecasts operational capacity only; it does not predict views, revenue, or ranking. Set `SIM_START_DATE`, `SIM_STREAMS_PER_DAY`, `SIM_HOURS_PER_STREAM`, `SIM_MOMENTS_PER_STREAM`, `SIM_PUBLIC_VIDEO_COHORT`, and `SIM_MISSING_ANALYSIS_SHARE` to model another scenario. Quota inputs follow YouTube's published method costs and default daily allowance; actual project quota can differ.

## Security model

- Google passwords are never collected.
- OAuth credentials and refresh tokens are never committed to GitHub.
- YouTube and Twitch tokens are encrypted with AES-256-GCM before database storage.
- TikTok access and refresh tokens use the same encrypted database storage.
- `AGENT_KEY` can upload private drafts but cannot publish them.
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
- `AGENT_KEY`: long random upload-only secret
- `ADMIN_KEY`: different owner-only secret

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

Each package contains three search titles, three curiosity titles, three hybrid titles (each under 60 characters), three thumbnail briefs, a 50–160 character keyword hook, description paragraphs, chapters where validated times exist, resource placeholders, three hashtags, 3–8 focused tags, a pinned comment draft, a community post teaser, and 2–3 clip recommendations when enough source moments exist. Automatic application selects a hybrid title, joins the evidence-backed hook and paragraphs with the existing description, and merges relevant tags. For eligible public videos, Amaana also composes a 1280×720 JPEG from the current YouTube thumbnail and a short overlay grounded in the title, description, tags, or video analysis, then uploads it as the custom thumbnail. It preserves the existing image if there is no usable YouTube thumbnail or supported text. It never sends resource placeholders, unverified chapters, comments, or Community posts. No SEO result or AI summary appearance is guaranteed.

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

## Shorts requirements

Use square or vertical video no longer than three minutes. For gameplay, 1080×1920 (9:16) is recommended. Confirm music and footage rights before uploading.

New Google API projects can be limited to private API uploads until Google completes an API compliance audit. Private drafts will still work, but public automation may require that audit.
