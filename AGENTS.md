# Repo map for agents

Stremio Community v5 is a **Windows shell**, not the Stremio UI. Knowing which
side of that line a task falls on decides everything about how to do it.

| Layer | Lives in | Language |
| --- | --- | --- |
| Native shell (window, tray, updater, mpv, WebView2 host) | `src/` | C++ |
| Injected UI tweaks ("webmods") | `utils/webmods/` | plain JS/CSS, no build |
| Player config / scripts shipped to users | `utils/` → `portable_config/` | mpv conf, Lua |
| Build + packaging | `build/`, `build_msvc.bat`, `deploy_quick.bat`, `CMakeLists.txt`, `utils/windows/installer/` | Node, batch, CMake, NSIS |

**The web UI is remote.** `src/core/globals.cpp` holds the candidate URLs, tried
in order by `GetFirstReachableUrl()`: our own `AlcDevs/stremio-web` build
(`alcdevs.github.io/stremio-web`), then `stremio.zarg.me`, a GitHub Pages fixes
build, then `web.stremio.com`; `--webui-url=` overrides. Anything about the
episode list, streams list, menus, settings screens, theming — i.e. anything a
user sees inside the window — is **not in this repo**.

Our own build (`AlcDevs/stremio-web`) is a proper source merge kept in sync with
upstream `Stremio/stremio-web`, and it's where UI features now belong — its
`webmods/` directory bakes injected mods straight into that build's own
`index.html`, so they apply on that site with or without this native shell.
`utils/webmods/` here still exists for a shell-only mod that should *not* ship
with the web build; see [`utils/webmods/AGENTS.md`](utils/webmods/AGENTS.md) for
that narrower case and how `SetupWebMods()`'s injection pipeline works.

## Builds

- Full build + deploy: `build_msvc.bat` (add `--x86` for 32-bit) — sets up MSVC,
  optionally uses `sccache`, then runs `node build/deploy_windows.js`.
- Webmods / mpv config only: `deploy_quick.bat` — copies into
  `dist/win-x64/portable_config/` with no rebuild. Use this while iterating on a
  webmod.
- Output lands in `dist/` (gitignored). Version metadata is in `version/`, and
  release steps are in `docs/RELEASE.md`; Windows specifics in `docs/WINDOWS.md`.
