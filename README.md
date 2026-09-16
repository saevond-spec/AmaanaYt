# AmaanaYt

Approval-based YouTube Shorts publishing service for **@saevond**.

AmaanaYt connects to YouTube with Google OAuth, lets an OpenClaw agent upload Shorts as **private drafts**, and requires a separate owner key before a draft can become public or scheduled.

## Security model

- Google password is never collected.
- OAuth credentials and refresh tokens are never committed to GitHub.
- Stored YouTube tokens are encrypted with AES-256-GCM.
- `AGENT_KEY` can upload private drafts but cannot publish them.
- `ADMIN_KEY` is owner-only and controls OAuth connection, draft review, publication, and scheduling.
- New uploads always start as private.
- The service does not delete existing channel videos.

Keep `ADMIN_KEY` out of OpenClaw. Give OpenClaw only `AGENT_KEY`.

## 1. Google Cloud setup

1. Create a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the Google Auth consent screen.
4. Create an OAuth client of type **Web application**.
5. Add this authorized redirect URI exactly:
   `https://YOUR-SERVICE-DOMAIN/oauth2/callback`
6. Save the client ID and client secret as hosting environment variables. Never commit them.

The requested OAuth scope is only:

`https://www.googleapis.com/auth/youtube.upload`

## 2. Environment variables

Copy `.env.example` to `.env` for local development.

Generate strong secrets:

```bash
openssl rand -hex 32
```

Use separate generated values for `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AGENT_KEY`, and `ADMIN_KEY`. `TOKEN_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters.

Set `BASE_URL` to the public HTTPS origin with no trailing path, for example:

`https://amaana-yt.example.com`

## 3. Run locally

```bash
npm install
npm start
```

Health check:

`GET /healthz`

## 4. Connect @saevond to YouTube

Open this URL in your normal browser and send the owner key as the `x-admin-key` header:

`GET /auth/google`

For easiest setup, use an API client such as Postman for this one request. Sign in on Google's own page, choose the Google account that owns **@saevond**, review the requested upload permission, and approve it.

The callback stores an encrypted refresh token in `DATA_DIR`. That directory must use persistent storage in production or the connection will be lost when the service restarts.

## 5. OpenClaw installation

Copy this folder into the OpenClaw skills directory:

`skills/youtube-manager`

Configure the OpenClaw runtime with:

- `AMAANA_YT_URL`: deployed service origin
- `AMAANA_YT_AGENT_KEY`: same value as the service's `AGENT_KEY`

Do **not** give OpenClaw `ADMIN_KEY`.

## API workflow

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

### Review drafts as the owner

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

Scheduled videos must remain private until YouTube releases them at `publishAt`.

## Shorts requirements

Use square or vertical video no longer than three minutes. For gameplay, 1080×1920 (9:16) is recommended. Confirm music and footage rights before uploading.

## Deployment note

`render.yaml` includes a persistent disk because encrypted OAuth tokens and the approval ledger must survive restarts. Confirm the current hosting price before deploying; persistent disks may not be included in free hosting.

New Google API projects created after July 28, 2020 can be limited to private API uploads until Google completes an API compliance audit. The private-first workflow will still upload drafts, but public automation may require that audit.
