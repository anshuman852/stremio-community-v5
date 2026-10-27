# Releasing New Version

---

## 🚀 Quick Overview

1. Bump version in ``cmakelists`` and ``APP_VERSION`` in ``main.cpp``
2. Build new ``runtime`` and `installer`
3. Make sure `installer` is in `/utils` and `server.js` in `/utils/windows`
4. Run ``build/build_checksums.js`` this will generate `version.json` and `version-details.json` needed for the auto updater
```
node build_checksums.js <OpenSSL_Bin> <Git_Tag> <Shell_Version> <Server.js_Version>
```
```
node build_checksums.js "C:\Program Files\OpenSSL-Win64\bin" "5.0.0-beta.8" "5.0.8" v4.20.11
```

> **⏳Note:** Only Windows at the moment

5. Commit Changes
6. Make new release with the Git tag used when running ``build_checksums.js``
7. Verify the published release assets before announcing it (catches corrupted
   uploads/downloads early, i.e. the "NSIS Error: Installer integrity check has
   failed" class of problem):
   ```
   node build/verify_release.js <Git_Tag>
   ```
   The script downloads every asset of the release, compares digests against the
   published `.sha256` files, runs a full CRC integrity test via 7-Zip, and
   checks `version/version-details.json` points at this tag with matching
   checksums (what the auto-updater will consume). Exit code 1 on any failure.

> **⏳Note:** Alternatively u can separate the version bump commit. Instead:
> Commit - Release - Build Checksums - Commit Built Checksums


## CI (GitHub Actions)

The **Build & Release (Windows)** workflow (`.github/workflows/release.yml`) automates
everything above: it derives the versions from a tag, bumps `CMakeLists.txt` +
`APP_VERSION`, provisions the external dependencies, builds both architectures
(MSVC + NSIS + portable 7z), enforces the NSIS integrity pre-check, runs
`build_checksums.js` (signing), commits the metadata, publishes the release with
all six assets (`Stremio.<ver>-x64.exe`/`-x86.exe` + `.sha256` + portable `.7z`),
and then verifies the published release end-to-end from a clean machine.

**One-time setup (maintainer):** add the repository secret
`SIGNING_PRIVATE_KEY` - the PEM contents of `private_key.pem` (the auto-updater
signing key). The workflow writes it to a temporary file only for the signing
step and deletes it before anything is uploaded.

**Usage:** `Actions -> Build & Release (Windows) -> Run workflow`

| input | meaning |
|---|---|
| `git_tag` | tag to release, e.g. `5.0.0-beta.31` (required) |
| `shell_version` | override; default derived from the tag (`5.0.31`) |
| `server_version` | override; default = current pin in `version-details.json` |
| `build_portable` | also build the portable `.7z` archives (default: on) |
| `publish_release` | publish + verify the release; off = artifacts only |

- Run the workflow **on the release branch** (`webview-windows`); the metadata
  commit lands on it (the "Commit Changes" step above happens inside the run).
- Re-running for the same tag: delete the existing release + tag first, or
  uncheck `publish_release` to only produce build artifacts.
- The first run takes long (vcpkg compiles OpenSSL/CURL; ~1-1.5h). Binary and
  provision caches make subsequent runs substantially faster.

## Chocolatey
1. ``cd utils/chocolatey``
2. Run and bump version in ``.nuspec`` and in `choco push`:
```shell
 choco pack stremio.nuspec
 choco push stremio-desktop-v5.5.0.8.nupkg --source https://push.chocolatey.org/ --api-key {api-key}
```

## Scoop
1. Run ``build-checksums.js``
2. Commit updated ``scoop.json``
3. Sync scoop bucket ``node sync.js`` in ``scoop`` repo
