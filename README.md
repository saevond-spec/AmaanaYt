# AmaanaYt

Approval-based YouTube Shorts publishing service for **@saevond**.

AmaanaYt connects to YouTube with Google OAuth, lets an OpenClaw agent upload Shorts as private drafts, and requires a separate owner key before a draft can become public or scheduled.

## Security model

- Google passwords are never collected.
- OAuth credentials and refresh tokens are never committed to GitHub.
- YouTube tokens are encrypted with AES-256-GCM before database storage.
- `AGENT_KEY` can upload private drafts but cannot publish them.
- `ADMIN_KEY` controls OAuth connection, draft review, publication, and scheduling.
- New uploads always start as private.
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
- `TOKEN_ENCRYPTION_KEY`: exactly 64 hexadecimal characters
- `AGENT_KEY`: long random upload-only secret
- `ADMIN_KEY`: different owner-only secret

Render generates `SESSION_SECRET`.

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

The app requests only:

`https://www.googleapis.com/auth/youtube.upload`

## 4. Verify deployment

Open:

`https://YOUR-RENDER-DOMAIN/healthz`

Expected response:

```json
{"ok":true,"database":"connected"}
```

## 5. Connect @saevond

Send an authenticated request to:

`GET /auth/google`

using the `x-admin-key` header. Open the returned Google authorization URL, choose the Google account that owns **@saevond**, and approve the upload permission.

## 6. OpenClaw installation

Copy `skills/youtube-manager` into the OpenClaw skills directory and configure:

- `AMAANA_YT_URL`: deployed Render origin
- `AMAANA_YT_AGENT_KEY`: same value as `AGENT_KEY`

Do not give OpenClaw `ADMIN_KEY`.

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
