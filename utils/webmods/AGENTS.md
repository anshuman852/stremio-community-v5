# Webmods have moved

The active webmods (`stream-search.js`, `episode-scroll.js`,
`mark-previous-watched.js`) and their build/maintenance docs now live in
[`AlcDevs/stremio-web`](https://github.com/AlcDevs/stremio-web)'s `webmods/`
directory, wired directly into that repo's webpack build (`<script>` tags in
`src/index.html`, copied verbatim by `CopyWebpackPlugin`). The web build served
from `https://alcdevs.github.io/stremio-web/` already includes them - no native
injection needed when the shell points there.

This folder is kept only for the two inert theme experiments
(`fullscreen-on-launch.7z`, `liquid-glass-theme-v1.rar`) that were never wired
up as `.js`/`.css` webmods.

`SetupWebMods()` in `src/webview/webview.cpp` still works exactly as before -
if you ever need a shell-only mod that shouldn't ship with the web build
itself, drop a `.js`/`.css` file back in here.
