# AmaanaYT Live Highlight Autopilot (proposed branch)

This feature reuses the existing Twitch live VOD capture, gameplay-vision, video encoding, SEO, thumbnail, and YouTube publishing workers. It is **not** a separate model-per-agent system: its sub-agents are bounded specialist workflow roles coordinating existing AI-assisted tools.

## Behavior

- While Twitch is live and an accessible, correctly linked active archive exists, sample 60-second gameplay segments (default every three minutes).
- Require 900 seconds of selected game-category footage and recorded visual verification before staging an agent-managed batch.
- Generate one landscape 15-minute highlight and **three** ranked Shorts through the existing highlight processor. New live batches do not create separate periodic live Shorts from the same sample pool.
- Check upload media, YouTube processing, SEO registration, thumbnail status, permissions, and privacy before publication.
- Only these newly created live-agent batches can use the live-only auto-publication setting. Previously created drafts, private/unlisted channel videos and historical VOD processing are unaffected by this setting.
- If there are too few high-quality clips or an upload/check fails, hold rather than synthesize filler or bypass validation.

## Specialist roles

1. Gameplay analyst: consumes visually verified gameplay event and clip evidence.
2. Highlight editor: coordinates the 900-second selection and existing encoding worker.
3. Shorts editor: selects three ranked, non-duplicate moments for vertical rendering.
4. SEO specialist: existing metadata/playlist SEO workers.
5. Quality controller: existing media and YouTube processing verification gates.
6. Publishing manager: existing owner exclusion, visibility, OAuth, and publication gates.

These roles share an `agentPlan` attached to each new batch for dashboard/diagnostic use. Further independent model execution and agent-specific dashboards require subsequent work.

## Controls

- `LIVE_HIGHLIGHT_AUTO_PUBLISH=false` disables automatic publication for the new live-agent batches.
- `HIGHLIGHT_AUTO_PUBLISH` continues to control older/archived highlight batches according to its existing behavior.
- Gameplay vision provider(s), Twitch authentication, YouTube publish permission, sufficient active VOD footage, FFmpeg, reliable persistent storage and Render compute are required.
- There is no promise of a completed video during a stream if Twitch active VOD or verified segment availability is insufficient.
- Twitch automatic event markers may still create **private review drafts** separately; they are not part of the three auto-published batch Shorts.

## Verification before merge/deploy

Run `npm run check && npm test`; run a controlled Twitch test stream, monitor live scan status, inspect batch `agentPlan`, confirm exactly one 900s landscape output and three distinct Shorts, and verify no existing private/unlisted video changes. Publication must be checked on YouTube before declaring a live test successful.
