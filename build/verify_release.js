#!/usr/bin/env node
/****************************************************
 * verify_release.js
 *
 * Usage:
 *   node verify_release.js <GitTag>
 *   node verify_release.js <GitTag> [--repo owner/name] [--outdir DIR] [--skip-manifest-check]
 *
 * Example:
 *   node verify_release.js 5.0.0-beta.30
 *
 * This script verifies that a published GitHub release is complete and
 * intact BEFORE/after announcing it. For each release asset it checks:
 *   1) The asset downloads completely (byte size matches the API listing).
 *   2) Every <name>.exe/.7z matches its published <name>.sha256 digest.
 *   3) NSIS installer `.exe` assets pass NSIS's own CRC integrity check
 *      (the footer NSIS validates at startup) and all `.exe`/`.7z` assets
 *      pass a full CRC decompression test with 7-Zip (`7z t`); mismatching
 *      NSIS CRC footers are exactly the "Installer integrity check has
 *      failed" on every user machine.
 *   4) version/version-details.json in the repo points at THIS tag's asset
 *      URLs and its checksums equal the digests of the actually downloaded
 *      installer files (protects the auto-updater from stale manifests).
 *      Skipped with --skip-manifest-check.
 *
 * Exit code: 0 if everything is OK, 1 on any failure.
 * Notes:
 *   - Requires Node >= 18 (global fetch, crypto).
 *   - 7-Zip is located in common install paths or on PATH; without it,
 *     CRC testing is skipped and a warning is printed.
 ****************************************************/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { verifyNsisFile } = require("./nsis_checker");

const DEFAULT_REPO = "anshuman852/stremio-community-v5";

function parseArgs(argv) {
    const args = { repo: DEFAULT_REPO, outdir: null, skipManifestCheck: false, tag: null };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--repo") args.repo = argv[++i];
        else if (a === "--outdir") args.outdir = argv[++i];
        else if (a === "--skip-manifest-check") args.skipManifestCheck = true;
        else positional.push(a);
    }
    if (positional.length < 1) {
        console.error("Usage: node verify_release.js <GitTag> [--repo owner/name] [--outdir DIR] [--skip-manifest-check]");
        process.exit(1);
    }
    args.tag = positional[0];
    return args;
}

function find7z() {
    const candidates = [
        process.env.SEVENZ_PATH,
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "shims", "7z.exe") : null
    ].filter(Boolean);
    const found = candidates.find(p => fs.existsSync(p));
    if (found) return found;
    // `where` exists on Windows; `which` on POSIX
    const locators = process.platform === "win32" ? ["where"] : ["which"];
    for (const loc of locators) {
        try {
            return execFileSync(loc, ["7z"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() || null;
        } catch (e) { /* try the next locator */ }
    }
    return null;
}

function sha256File(file) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(file));
    return hash.digest("hex").toLowerCase();
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: { "User-Agent": "stremio-community-v5-release-check" } });
    if (!res.ok) {
        if (res.status === 404) throw new Error(`Release/tag not found (404): ${url}`);
        throw new Error(`GitHub API returned ${res.status} for ${url}`);
    }
    return res.json();
}

async function download(url, dest) {
    const res = await fetch(url, { headers: { "User-Agent": "stremio-community-v5-release-check" } });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
    return buffer.length;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const tag = args.tag;
    const outDir = args.outdir || path.join(__dirname, "release-check", tag);
    fs.mkdirSync(outDir, { recursive: true });

    const failures = [];
    const warn = msg => console.warn("WARNING: " + msg);
    const fail = msg => { console.error("FAIL: " + msg); failures.push(msg); };

    console.log("Verifying release:", tag);
    console.log("Repository:", args.repo);
    console.log("Download dir:", outDir);
    console.log();

    // 1) List assets for the tag via the GitHub API
    const release = await fetchJson(`https://api.github.com/repos/${args.repo}/releases/tags/${tag}`);
    const assets = (release.assets || []).filter(a => !a.name.endsWith(".sha256"));
    const shaAssets = (release.assets || []).filter(a => a.name.endsWith(".sha256"));

    if (assets.length === 0) fail(`No assets attached to release ${tag}`);

    console.log("Assets declared by the release (excluding .sha256):");
    for (const a of assets) console.log(`  - ${a.name} (${a.size} bytes)`);
    console.log();

    // 2) Download everything and verify sizes + digests
    const downloaded = {};
    for (const asset of assets) {
        const dest = path.join(outDir, asset.name);
        // Skip reuse of a previous run's file only if it already has the exact API size.
        if (fs.existsSync(dest) && fs.statSync(dest).size === asset.size) {
            console.log(`Reusing existing download: ${asset.name}`);
        } else {
            console.log(`Downloading: ${asset.name} ...`);
            try {
                const size = await download(asset.browser_download_url, dest);
                if (size !== asset.size) fail(`${asset.name}: downloaded ${size} bytes, API lists ${asset.size}`);
            } catch (e) {
                fail(`${asset.name}: ${e.message}`);
                continue;
            }
        }
        downloaded[asset.name] = dest;
    }

    // Published .sha256 digests must match the actual files.
    for (const shaAsset of shaAssets) {
        const target = shaAsset.name.replace(/\.sha256$/, "");
        const dest = path.join(outDir, shaAsset.name);
        try {
            await download(shaAsset.browser_download_url, dest);
        } catch (e) {
            fail(`${shaAsset.name}: ${e.message}`);
            continue;
        }
        const published = fs.readFileSync(dest, "utf8").trim().split(/\s+/)[0].toLowerCase();
        const t = downloaded[target];
        if (!t) { fail(`.sha256 present for ${target} but the asset itself is missing/failed`); continue; }
        const actual = sha256File(t);
        if (published !== actual) fail(`${target}: sha256 mismatch (published ${published}, actual ${actual})`);
        else console.log(`OK sha256:   ${target} = ${actual}`);
    }

    // 3) Full CRC integrity test with 7-Zip (same class of check NSIS runs).
    const sevenZip = find7z();
    if (!sevenZip) {
        warn("7-Zip not found - skipping CRC integrity tests. Install 7-Zip for full verification.");
    } else {
        for (const [name, file] of Object.entries(downloaded)) {
            if (!/\.(exe|7z)$/i.test(name)) continue;
            console.log(`CRC test (7z t): ${name} ...`);
            try {
                execFileSync(sevenZip, ["t", file], { stdio: "pipe" });
                console.log(`OK CRC:      ${name}`);
            } catch (e) {
                const tail = String(e.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
                fail(`${name}: 7-Zip integrity test FAILED${tail ? " - " + tail : ""}`);
            }
        }
    }

    // 3b) NSIS's own integrity check for installer .exe assets. 7-Zip does NOT
    //     validate this checksum (it only decompresses the payload): a stale
    //     NSIS CRC footer passes here fatally on every user machine with
    //     "Installer integrity check has failed".
    for (const [name, file] of Object.entries(downloaded)) {
        if (!/\.exe$/i.test(name)) continue;
        console.log(`NSIS integrity check: ${name} ...`);
        try {
            if (verifyNsisFile(file)) console.log(`OK NSIS:     ${name}`);
            else fail(`${name}: NSIS CRC footer does not match the file bytes - every install of it aborts with "Installer integrity check has failed"`);
        } catch (e) {
            fail(`${name}: NSIS integrity check errored: ${e.message}`);
        }
    }

    // 4) version-details.json sanity vs this release (auto-updater manifest)
    if (!args.skipManifestCheck && assets.some(a => /Stremio\..+-x(64|86)\.exe$/.test(a.name))) {
        const detailsPath = path.join(__dirname, "..", "version", "version-details.json");
        if (fs.existsSync(detailsPath)) {
            let details;
            try {
                details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
            } catch (e) {
                fail(`version/version-details.json not valid JSON: ${e.message}`);
                details = null;
            }
            if (details) {
                for (const key of ["windows-x64", "windows-x86"]) {
                    const entry = details.files && details.files[key];
                    const assetName = key === "windows-x64" ? `Stremio.${details.shellVersion}-x64.exe` : `Stremio.${details.shellVersion}-x86.exe`;
                    const expectedUrl = `https://github.com/${args.repo}/releases/download/${tag}/${assetName}`;
                    if (!entry || typeof entry.url !== "string") {
                        fail(`version-details.json missing files.${key}.url`);
                        continue;
                    }
                    if (!entry.url.endsWith(expectedUrl)) {
                        fail(`version-details.json files.${key}.url does not point at ${tag} (${entry.url})`);
                    } else {
                        console.log(`OK manifest: ${key} -> ${tag}`);
                    }
                    const local = downloaded[assetName];
                    if (local && entry.checksum) {
                        const actual = sha256File(local);
                        if (actual !== String(entry.checksum).toLowerCase()) {
                            fail(`version-details.json files.${key}.checksum (${entry.checksum}) != actual digest of ${assetName} (${actual})`);
                        } else {
                            console.log(`OK checksum: ${key} matches ${assetName}`);
                        }
                    }
                }
            }
        } else {
            warn("version/version-details.json not found; skipping updater manifest checks.");
        }
    }

    console.log();
    if (failures.length > 0) {
        console.error(`Verification FAILED with ${failures.length} problem(s):`);
        failures.forEach((f, i) => console.error(`  ${i + 1}) ${f}`));
        process.exit(1);
    }
    console.log("Everything is OK - release assets are intact and consistent. Safe to announce.");
    process.exit(0);
}

main().catch(err => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
