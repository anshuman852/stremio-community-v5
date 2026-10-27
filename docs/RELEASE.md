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
