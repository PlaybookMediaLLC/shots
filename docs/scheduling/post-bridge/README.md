# Post Bridge technical reverse engineering

Inspected 13 October 2026. Four connected reports cover creation, media production, bulk preparation, post management, and connections. These are evidence-bound reconstruction specifications, not recovered private source code.

| Feature | Technical report | Supporting contract / checks |
|---|---|---|
| New Post: text, image, video, story | [Composer analysis](composer/post-bridge-new-post-technical-analysis.md) | [OpenAPI](composer/post-bridge-composer.openapi.json) · [Verification](composer/post-bridge-verification-matrix.csv) · [Shots implementation](composer/implementation.md) |
| Studio / Content Studio | [Studio analysis](content-studio/post-bridge-content-studio-technical-analysis.md) | [Verification](content-studio/studio-verification-matrix.csv) · [Generated MP4](content-studio/studio-ugc-test.mp4) |
| Bulk Tools | [Bulk analysis](bulk-tools/post-bridge-bulk-tools-technical-analysis.md) | [Observed contract](bulk-tools/bulk-tools-observed-contract.json) · [Verification](bulk-tools/bulk-tools-verification-matrix.csv) · [Generated MP4](bulk-tools/bulk-grid-test.mp4) |
| Calendar, All, Scheduled, Posted, Drafts, Connections | [Post management analysis](post-management/post-bridge-post-management-technical-analysis.md) | [Observed contract](post-management/post-management-observed-contract.json) · [Public API](post-management/post-management-public.openapi.json) · [Verification](post-management/post-management-verification-matrix.csv) |

Studio and Content Studio are the same feature. Studio produces media; the composer and bulk schedulers prepare posts; management views project post state; per-account results track delivery; Connections supplies destinations.

The latest report includes two confirmed UI defects: the team posted-result creation link opens Main, and the calendar grid covers timezone-menu options. It also highlights the documented API hazard where updating a scheduled post without resending its timestamp can trigger immediate processing.

No social post was published, scheduled, or saved during these inspections. Studio and Bulk video generation/download were exercised. Existing scheduled/draft records, provider authorization, group/note persistence, and end-to-end delivery remain untested where stated in the reports.
