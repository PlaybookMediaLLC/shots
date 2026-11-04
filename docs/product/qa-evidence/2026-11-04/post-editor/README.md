# Post editor: browser evidence (4 November 2026)

Captured with Playwright (Chromium) against the native stack in a cloud
container: `next dev` with the scripted AI model, the Go product API and
worker, PostgreSQL 16 and the collab server, signed in as the local dev
account. No social account was connected and nothing was scheduled or
published. "Before" is `develop` at `56ff0fb1`; "after" is
`claude/jolly-allen-rd16th`. Widths are CSS pixels.

The walkthroughs draw a blue dot for the pointer, a badge for special keys and
a caption per scene; the editor itself does not show these.

| File | What it shows |
| --- | --- |
| `walkthrough-desktop.gif`, `walkthrough-desktop.mp4` | 1280×800, about 90 seconds: an empty post (avatar, name, handle, platform placeholder); `/` opens about 20 post commands; arrow keys, fuzzy filtering, Escape keeping `/poll` as text, no match offering Ask AI; `/punch` reviewed first, accepted, then one ⌘Z restores the text; `/split`; `#` suggesting the workspace's hashtags and `:` finding emoji; a post past 280 characters with the red wash and ring, split at the limit from the post's More menu; the post bar on hover and Duplicate post; the selection bar's Bold; the toolbar's Emoji and More menus; an auto-split paste previewed before it applies; focus mode; dark mode and the slash menu in it |
| `walkthrough-phone.gif` | 390×780 touch: 16 px edges with the avatar, the slash menu as a bottom sheet, `/po` finding Poll, and More as a sheet |
| `before-*-composer.jpg`, `after-*-composer.jpg` | The composer in light and dark at 1440×900 and 584×715 |
| `before-*-slash.jpg`, `after-*-slash.jpg` | The slash menu in the same four states: 63 document blocks before, post commands after |
