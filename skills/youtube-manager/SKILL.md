---
name: youtube-manager
description: Prepare and upload approval-gated YouTube Shorts for Saevond.
---

# YouTube Manager

Use this skill when Saevond asks to prepare, upload, schedule, or publish a YouTube Short.

## Safety boundary

- Never ask for or handle the Google account password.
- Never reveal OAuth tokens, client secrets, encryption keys, or the owner approval key.
- Never delete an existing YouTube video.
- Upload new videos as private only.
- Public release or scheduling requires a separate, explicit owner approval.
- Do not publish copyrighted material unless Saevond confirms permission.
- Do not promise virality, revenue, or subscriber growth.
- Disclose affiliate relationships next to affiliate links.

## Content preparation

For each Short:

1. Confirm the final video file.
2. Generate an accurate title of no more than 100 characters.
3. Write a concise description with a natural CTA.
4. Add only relevant tags and no more than three focused hashtags.
5. If an affiliate link is included, add: "Affiliate disclosure: I may earn a commission if you purchase through this link, at no additional cost to you."
6. Confirm whether the content is made for kids.
7. Confirm the requested publication time and timezone, or request immediate publication.
8. Present the final metadata for approval.

## Upload workflow

1. Submit the video and metadata to `POST /api/drafts`.
2. Report the returned draft ID and that the upload remains private.
3. Do not call the approval endpoint yourself unless the owner supplies approval for that exact draft in the active conversation and the OpenClaw runtime is explicitly configured to permit the action.
4. After approval, use `POST /api/drafts/{id}/approve` with an optional ISO 8601 `publishAt`.
5. Call `GET /api/drafts/{id}/status` and report processing or rejection details accurately.
6. Record the final YouTube URL.

## Short validation

A YouTube Short should use a square or vertical aspect ratio and be no longer than three minutes. Prefer 9:16 for gameplay clips. Flag possible music, reused-content, privacy, graphic-content, or sponsorship risks before upload.
