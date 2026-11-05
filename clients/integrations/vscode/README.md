# Shots Code Studio for VS Code

**Shots: Send selection to Shots** (also in the editor's context menu) sends
the selected lines, or the whole file, to Code Studio and opens the new
project in your browser to style, export and post.

The first run asks for a workspace API key with the `asset:write` scope and
keeps it in VS Code's secret storage. Set `shots.origin` for another Shots
deployment and `shots.theme` for a default theme. The extension is not
published to the Marketplace yet; package it with `vsce package`.
