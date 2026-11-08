# Gameplay clipping options for AmaanaYT

**Reviewed:** November 8, 2026  
**Scope:** Fight and rare-loot moments, VOD-derived edits, local and cloud workflows, and keeping YouTube outputs private for owner review.

## What the 1,000-option screen means

There are not 1,000 independently credible clipper products. To avoid a narrow vendor-only search, this review maps 10 source paths × 10 event signals × 10 processing/editing paths = 1,000 plausible workflow combinations. The matrix is a search space, not a claim that every combination was installed or benchmarked. The shortlist below uses primary product documentation and only recommends combinations whose source media access, privacy, and review path are clear.

### Ten source paths

1. Creator timestamp marker during a Twitch live stream.
2. Twitch community clips attached to an archived VOD.
3. Twitch archived VOD segments discovered after a stream ends.
4. A local OBS recording.
5. An OBS replay-buffer file saved after an event.
6. A local console or phone recording exported by its owner.
7. Game recording with game-provided timeline markers.
8. A PC game-capture session with a supported event plug-in.
9. A YouTube mobile live recap highlight, when that feature's conditions are met.
10. A YouTube Studio highlight created from the creator's own stream markers.

### Ten event signals

1. Creator's explicit fight marker.
2. Creator's explicit rare-loot marker.
3. Game-provided kill, win, or match event.
4. Kill-feed or HUD text read with OCR.
5. A visible rarity label or item pickup.
6. Combat/action recognition from sampled frames.
7. Scene and motion changes.
8. Audio peaks or game sound cues.
9. A spoken “clip that” voice trigger.
10. Chat or multi-signal bursts used to rank a review queue.

### Ten processing and edit paths

1. Existing Amaana Twitch and YouTube APIs.
2. Local CPU computer vision and FFmpeg.
3. Local GPU vision and FFmpeg.
4. Local speech transcription plus a local model.
5. Browser or on-device inference.
6. Self-hosted desktop or home server.
7. Paid, metered cloud vision or speech APIs.
8. A game's native capture and timeline editor.
9. A platform's native highlight editor.
10. Human-in-the-loop selection and review.

## Options with evidence

| Option | Fight / loot fit | Cost and source limits | Fit for AmaanaYT |
|---|---|---|---|
| **Amaana live markers (added in this branch)** | Creator marks fight or rare loot; saves 15 seconds before and 25 seconds after. | No vidIQ or vision-AI call for this path. Uses the connected Twitch stream/VOD and the existing private YouTube upload flow. | Best immediate choice when streaming on Twitch. It remains a private draft for review. |
| **Amaana sampled-frame event labels (added in this branch)** | Gemini may label fight, rare loot, or clutch if the sampled images clearly show it; those labels can prioritize Shorts. | Uses the existing configured vision API and only sees sampled frames. It can miss an event between sampled frames. | Improves candidate labeling for Twitch VODs; it is a review aid, not guaranteed event detection. |
| **OBS replay buffer + Amaana private upload** | Save the replay after the event, trim/export the fight or loot moment locally, then use Amaana's existing video-file form. | OBS has an on-device replay buffer and hotkey; local storage and encoding time still apply. Amaana uploads the finished file as a private draft. | Strong backup for YouTube, console, or other streams when the game is visible in OBS. Amaana does not yet segment a full OBS recording automatically. |
| **Steam Game Recording** | Records and lets the player bookmark/clip; some games add their own event markers. | Captures games played through Steam. The game must supply timeline markers for game-event context. | Good zero-API-cost local capture when playing a compatible Steam title. It does not create Amaana drafts automatically. |
| **SteelSeries Moments** | Auto-clips events in a supported game; the event triggers can be adjusted. | PC capture and a maintained supported-game list; unsupported titles fall back to manual capture. | Useful only if the current game appears on its supported list. |
| **Medal** | Auto-clips supported game events; manual replay/clip capture is broader. | Automatic event detection is game-dependent and often relies on that game's Replay system; local recording remains available. | Another PC capture option, especially when the game has an integration. |
| **Outplayed** | Event-based highlight capture, full-match recording with bookmarks, manual hotkeys, and screen recording. | Overwolf Capture Modes and game integration determine which automatic events are available. | Broad PC capture fallback; not an archived YouTube/Twitch VOD processor. |
| **NVIDIA App Highlights** | Captures selected game events such as kills and match wins in supported games. | Requires a supported game/configuration and suitable PC capture environment. NVIDIA's older Highlights SDK is marked unsupported. | Consider the current NVIDIA App for compatible PC games; do not build around the unsupported SDK. |
| **VideoHighlighter** | Local analysis combines scene, motion, audio, objects, actions, and transcript for a local video file. | Free AGPL-3.0 desktop software; local hardware/time are the limit. Review AGPL obligations before incorporating its code into a hosted service. | Best researched offline candidate for a locally saved VOD; it does not solve live discovery or upload into Amaana. |
| **Auto-Clipper (community project)** | Local CV, YOLO, voice trigger, and timestamp tools; project currently lists Arc Raiders and War Thunder profiles. | Small community project. Its setup and its advertised URL-ingest path need security and platform-policy review. Local-file mode is the safer pilot. | Experimental only. Do not vendor it or allow it to publish. |
| **YouTube mobile recap highlight** | YouTube can save a Short highlight from an eligible mobile live stream. | Requires a 10-minute–12-hour vertical stream through the YouTube mobile app, chat enabled, not a screencast, and other eligibility conditions. Saved highlight defaults private. | Helpful if the stream itself is made through the YouTube mobile app; not the usual OBS/console gaming stream. |
| **YouTube Studio stream markers / highlight editor** | Creator inserts stream markers and trims the archive in Studio. | Manual editing. Studio lets the creator set privacy before Create, then immediately creates the highlight at that visibility instead of adding it to Amaana's review queue. | Useful as a creator-operated option when the archive is available. Do not wire it into Amaana's automation. |

## Decision

Keep the project on two tracks:

1. **Twitch live:** use Amaana's new fight/rare-loot marker buttons for reliable, no-vision-call candidate capture. Use optional sampled-frame labels as a second signal when the configured vision API is available.
2. **YouTube or other non-Twitch streams:** save a local OBS/game recording and mark or clip locally. Amaana's existing video-file form can upload the finished clip as a private draft for review; it cannot turn an arbitrary YouTube archive into a segment through its current YouTube API connection. YouTube's Live API cuepoint is an ad cuepoint that may trigger an ad break, not a highlight marker, so it is intentionally not used for this feature.

No public-visibility change, draft approval, or publishing action is part of either route. The current marker flow is Twitch-only; the YouTube mobile recap and the manual OBS route are separate alternatives, not implemented integrations.

## vidIQ and “unlimited” processing

vidIQ is an SEO and channel analytics tool; it is not the source of the project's Twitch clip timestamps. Amaana reads public YouTube `viewCount` through the YouTube Data API for its own video metadata. That avoids vidIQ's per-call credits for the app's own public counts, but YouTube API quota still applies. There is no genuinely unlimited hosted analysis tier. Local processing removes per-call API billing, while its limits become the creator's PC/GPU, storage, and elapsed processing time. The new manual marker path removes the extra AI/vidIQ dependency altogether for Twitch moments.

## Primary references

- [YouTube: Create a highlight](https://support.google.com/youtube/answer/4522163?hl=en)
- [YouTube: Promote your live stream](https://support.google.com/youtube/answer/2524542?hl=en)
- [YouTube Live API: cuepoint](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/cuepoint)
- [OBS: Replay Buffer overview](https://obsproject.com/kb/obs-studio-overview)
- [Steam: Game Recording](https://store.steampowered.com/gamerecording)
- [SteelSeries: Moments auto-clip](https://support.steelseries.com/hc/en-us/articles/360060115032-What-is-auto-clip-with-SteelSeries-Moments)
- [Medal: automatic event detection](https://support.medal.tv/support/solutions/articles/48001167701-what-is-automatic-event-detection-auto-clipping-)
- [Overwolf: Outplayed overview](https://support.overwolf.com/support/solutions/articles/9000284664-what-is-outplayed-)
- [NVIDIA App](https://www.nvidia.com/en-us/software/nvidia-app/)
- [NVIDIA Highlights SDK status](https://developer.nvidia.com/Highlights)
- [VideoHighlighter](https://github.com/Aseiel/VideoHighlighter)
- [Auto-Clipper](https://github.com/bendawg2010/Auto-clipper)
