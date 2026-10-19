# Amaana gaming editor: market research and selection method

**Checked:** October 19, 2026

**Scope:** Amaana only; the creator's own archived Twitch VODs, a 15-minute landscape highlight, and up to two Shorts.

## Market findings

- YouTube says there is no universal ideal video length and advises creators to avoid filler and use audience retention to tune length. The 15-minute duration here is the requested output format; it is not a claim that YouTube recommends 15 minutes. [YouTube recommendations guidance](https://support.google.com/youtube/answer/16559651?hl=en)
- Since August 24, 2026, YouTube counts public views when playback starts across Shorts, long-form, and live. Its engaged-view metric preserves a stronger signal for people who continue watching. Amaana's seven-day competitor view velocity therefore measures public starts, not retention or satisfaction; assess the creator's own work with engaged views and retention. [YouTube view-count update](https://support.google.com/youtube/blog/433409976/an-update-to-how-we-count-public-views-across-youtube?hl=en-GB)
- Streamlabs and Hatchet reported 1.79 billion YouTube Gaming hours watched in Q2 2026, down 18.9% year over year; broader YouTube Live was up 18.0%, but includes non-gaming viewing. This supports testing specific games and formats against the channel's own analytics, not assuming the overall platform trend predicts this channel's performance. [Q2 2026 streaming report](https://streamlabs.com/content-hub/post/streamlabs-and-hatchet-q2-2026-live-streaming-report)
- Twitch's Get Clips response uses `vod_offset` for the clip's start in the VOD. The Create Clip From VOD endpoint instead interprets `vod_offset` as the clip's end and limits a clip to 5–60 seconds. Amaana keeps those meanings separate and verifies the requested timestamps. [Twitch API reference](https://dev.twitch.tv/docs/api/reference)
- Eklipse advertises whole-VOD game-aware scoring using gameplay events, screen markers, audio energy, and chat reactions, followed by captions and vertical reframing. StreamLadder advertises AI stream clipping, captioning, layouts, and publishing. These are vendors' descriptions of their products, not independent performance benchmarks. [Eklipse highlights](https://eklipse.gg/features/ai-highlights/) · [Eklipse Content Agent](https://eklipse.gg/features/content-agent/) · [StreamLadder AI clipping](https://www.streamladder.com/clipgpt/ai-clipping) · [StreamLadder captions](https://www.streamladder.com/clip-editor/captions)

## Amaana changes

Amaana selects only clips linked to the requested VOD and broadcaster that also have Twitch game-category metadata. It requires at least 900 seconds of non-overlapping source moments, with no more than 20 cuts. It samples five frames from every selected source and asks the configured Gemini vision model to verify active gameplay. A clip passes only if at least 4 of 5 frames are active gameplay with per-frame confidence of at least 0.75 and average confidence of at least 0.80. This is a fail-closed sampled-frame check, not a full-frame guarantee or game-event detector.

Gameplay frame screening is off by default. It runs only when `ENABLE_GAMEPLAY_SCREENING=true` and `VIDEO_ANALYSIS_API_KEY` is configured; the sampled frames are then sent to Gemini. Amaana rejects portrait-only sources, renders a landscape video to exactly 900 seconds, and makes up to two Shorts from the selected moments with the highest selection scores. If the VOD lacks enough source material or screening is unavailable, Amaana holds the job without padding or uploading it. YouTube outputs remain private for owner review.

## Selection math

For eligible clip \(i\), Amaana computes a bounded score:

\[
q_i = 0.65\frac{\log(1+v_i)}{\log(1+v_{\max})}
     + 0.25e^{-a_i/48}
     + 0.10\frac{1}{\sqrt{c_i}}
\]

where \(v_i\) is Twitch view count, \(a_i\) is the absolute age difference in hours between the clip and its VOD, and \(c_i\) is the number of candidate clips in the same five-minute VOD window. Log scaling keeps one viral clip from dominating; the density term softly favors less-crowded parts of the stream.

A weighted interval knapsack chooses the highest-scoring set subject to non-overlap, a three-second separation, a maximum of 20 cuts, and enough footage to trim the final selected clip to 900 seconds. The last cut is shortened as needed; no black frames or repeated footage are inserted to reach the target. The objective ranks candidate edits; it does not predict views or audience retention.

## How to evaluate

Review the private draft before approval. After publication, compare similar gaming videos using YouTube Analytics: impressions click-through rate, first-30-second retention, retention dips and spikes, and comparable-length typical retention. For Shorts, compare engaged views, chose-to-view, average view duration, and average percentage viewed. Change one editing variable at a time; neither competitor feature pages nor this scoring formula establishes a view lift.

The present patch improves clip selection, gameplay verification, exact duration, and source framing. It does not yet add full-VOD game-event/audio/chat scoring, auto-captioning, or action-tracked reframing. Those are the largest capability gaps suggested by the current product landscape.

The current two-year scenario data is anchored to official ARC Raiders and NARAKA: BLADEPOINT event windows checked on October 19, 2026. When events overlap, the scenario counts a planned upload against each active game's window. Those windows are illustrative topic timing, not a claim that scheduled uploads receive extra recommendations.
