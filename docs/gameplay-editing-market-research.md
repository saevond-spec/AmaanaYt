# Gaming video editing: current platform research

**Checked:** October 7, 2026  
**Product:** AmaanaYT, for creator-owned Twitch gameplay archives processed into YouTube highlights and Shorts.

## What the platform guidance says

- YouTube describes recommendations through viewer appeal, engagement, and satisfaction. It advises concise openings that deliver the title or thumbnail promise, story that sustains attention, and retention analysis. It says there is no universal ideal video length; use the creator's own retention data. [Recommendation performance guidance](https://support.google.com/youtube/answer/16559650?hl=en) · [Audience retention report](https://support.google.com/youtube/answer/9314415) · [Video length and recommendations](https://support.google.com/youtube/answer/16559651?hl=en)
- Shorts discovery is personalized, and YouTube says it does not favor one Shorts format. It considers whether people choose to watch, average view duration, average percentage viewed, and satisfaction signals. Shorts views include starts and replays; Engaged views remain available for judging whether viewers chose to continue. [Shorts search and discovery](https://support.google.com/youtube/answer/11914225?hl=en) · [Shorts view metrics](https://support.google.com/youtube/answer/10059070?hl=en)
- YouTube's October 2026 Shorts originality update says simple technical or template edits add little value on their own; it recommends meaningful original perspective, editing, or storytelling. Amaana's input footage is the broadcaster's own archive, and the story-first cut is an editorial structure over supplied, creator-owned moments. [Shorts originality update](https://support.google.com/youtube/blog/470890423/prioritizing-original-content-on-shorts?hl=en)
- YouTube's 2026 creator announcements describe prompt-driven Shorts editing that can trim, sync music, add text hooks, and reorder frames. This points to an increasingly assisted editing workflow, but does not establish demand for a particular automated editing feature or guarantee audience growth. [Made On YouTube 2026](https://www.blog.youtube/madeonyoutube/)
- YouTube's 2025 trends summary describes gaming as a wider fandom and culture format, not only gameplay footage. It is a broad platform signal, not a channel-specific forecast. [Top YouTube trends to know for 2025](https://business.google.com/en-all/think/search-and-video/2025-youtube-trends/)
- Twitch's clip API documents 5–60 second clips and defines vod_offset as the clip end position. It also documents that VOD linkage can be temporarily missing for clips created during a live broadcast. Amaana continues to require a completed broadcaster-owned archive and verifies returned VOD offsets before editing. [Twitch Clips API](https://dev.twitch.tv/docs/api/reference) · [Twitch Clips guide](https://dev.twitch.tv/docs/api/clips/)

## Product landscape (checked October 7, 2026)

| Product | Current official features | Market implication |
| --- | --- | --- |
| [Eklipse](https://eklipse.gg/features/) | Game-aware highlight detection, vertical conversion, browser editing, captions/overlays, and publishing or scheduling for short-form platforms. | Direct gaming-stream competitor with a broader automatic repurposing workflow. |
| [Medal](https://medal.tv/auto-clipping) | PC/mobile gameplay capture, automatic clips for supported game events, and built-in trim/edit/share tools. Its auto-clipping support depends on the game and event list. | Capture-first gaming tool; coverage varies by game and event. |
| [OpusClip](https://www.opus.pro/editor) | General long-video-to-shorts workflow; its official editor page lists gaming and tools for captions, layouts, reframing, and publishing. | Broad repurposing competitor for stream recordings and other long videos. |
| [CapCut Desktop](https://www.capcut.com/tools/desktop-ai-power) | General-purpose editing with auto-reframe, captions, and other AI tools. CapCut currently documents Auto Reframe as a Pro feature. | Flexible finishing editor; creators still control the edit. |

The category already has strong clip detection and short-form editing products. Amaana should complement the existing creator workflow: work from SweatyClanker-supplied timestamps, verify the broadcaster-owned Twitch archive and clip offsets, make a modest story-first assembly, then hold the full YouTube bundle private for review. This is a channel-specific workflow choice, not a claim that Amaana replaces those editors or that the reorder alone will increase views. Public feature pages are not adoption or performance benchmarks.

## Product decision

Amaana's default story edit puts the highest nonzero supplied moment score first, then keeps the other supplied moments in chronological stream order. It does not remove any selected moment. Equal scores resolve to the earliest source timestamp. If scores are absent or zero, it keeps chronology. A request can set `editingStyle` to `chronological` to disable the story-first order.

Amaana does not inspect gameplay to invent moments, captions, claims, or scores. SweatyClanker supplies candidate timestamps, titles, reasons, and any score. One YouTube Short remains tied to each supplied moment. No music or commentary is added automatically.

## How to measure the result

Use a controlled before/after comparison on the channel's own comparable gaming uploads:

1. Compare like formats and similar games/topics over the same observation window.
2. For long-form videos, review impressions click-through rate together with the first 30 seconds and later retention dips/spikes.
3. For Shorts, compare Engaged views, chose-to-view behavior, average view duration, and average percentage viewed; do not treat raw starts as proof that the edit held attention.
4. Review comments and returning-viewer patterns before changing the edit again.
5. Change one editing variable at a time and record the edit style, source moments, title, thumbnail, upload date, and observation window.

No Amaana channel-level analytics are included in this research note, so it does not estimate audience size, view lift, ranking, or revenue.
