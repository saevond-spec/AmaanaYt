# AmaanaYt

Approval-based YouTube Shorts and TikTok inbox service for **@saevond**.

AmaanaYt connects to YouTube and Twitch with OAuth. After SweatyClanker detects moments in an ended Twitch stream, Amaana assembles them into a landscape highlight video, then cuts vertical Shorts from that assembled video. The highlight and each Short become separate private YouTube drafts; an owner key is required to publish or schedule each one.

Generated Shorts can also be sent to the creator's TikTok inbox **one at a time after the creator previews and consents to each transfer**. The creator edits and completes each post in the TikTok app. TikTok delivery does not happen automatically at stream end.

## Security model

- Google passwords are never collected.
- OAuth credentials and refresh tokens are never committed to GitHub.
- YouTube and Twitch tokens are encrypted with AES-256-GCM before database storage.
- TikTok access and refresh tokens use the same encrypted database storage.
- `AGENT_KEY` can upload private drafts but cannot publish them.
- `ADMIN_KEY` controls OAuth connection, draft review, publication, and scheduling.
- New uploads always start as private.
- TikTok delivery requires owner approval per Short. TikTok media URLs are signed and expire.
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
6. Save the complete URI as `DATABASE_URL` in Render.

It resembles:

`postgresql://postgres.PROJECT:PASSWORD@POOLER-HOST:5432/postgres`

Treat this URL as a secret. Never commit or post it publicly. AmaanaYt creates its two required tables automatically.

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
- `DATABASE_URL`: external PostgreSQL session-pooler URI
- `GOOGLE_CLIENT_ID`: Google OAuth web client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `TWITCH_CLIENT_ID`: client ID for a dedicated Twitch application
- `TWITCH_CLIENT_SECRET`: secret for that Twitch application
- `TOKEN_ENCRYPTION_KEY`: exactly 64 hexadecimal characters
- `AGENT_KEY`: long random upload-only secret
- `ADMIN_KEY`: different owner-only secret

Render generates `SESSION_SECRET`.

For TikTok inbox delivery, also configure `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, and the URL verification values described below.

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

After a Short appears in Amaana, open its private YouTube preview, review the audio and footage, check the consent box, and select **Send to TikTok inbox**. TikTok will notify the connected creator account. Open the TikTok inbox notification to edit the post, add the suggested caption if desired, and publish it. Use **Check TikTok status** in Amaana to see when delivery or publication completes.

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
- `CLIP_WEBHOOK_KEY`: the same secret already stored as Amaana's `AGENT_KEY`
- `HIGHLIGHT_DETECTION_ENABLED=true`

Never paste the webhook key into chat or commit it to GitHub.

## 8. OpenClaw installation

Copy `skills/youtube-manager` into the OpenClaw skills directory and configure:

- `AMAANA_YT_URL`: deployed Render origin
- `AMAANA_YT_AGENT_KEY`: same value as `AGENT_KEY`

Do not give OpenClaw `ADMIN_KEY`.

## API workflow

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
