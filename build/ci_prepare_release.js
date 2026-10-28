#!/usr/bin/env node
/****************************************************
 * ci_prepare_release.js
 *
 * CI helper for the "Build & Release" GitHub Actions workflow.
 *
 * Usage:
 *   node build/ci_prepare_release.js <GitTag> [--shell-version <v>] [--server-version <v>]
 *
 * STDOUT carries ONLY `KEY=VALUE` lines (the workflow pipes them into
 * $GITHUB_ENV); every diagnostic goes to STDERR:
 *   GIT_TAG=5.0.0-beta.31
 *   SHELL_VERSION=5.0.31
 *   SERVER_VERSION=v4.20.15
 *
 * Actions:
 *   1) Validates the tag ("X.Y.Z-beta.N", optional "v" prefix).
 *   2) SHELL_VERSION: explicit --shell-version override, else derived from
 *      the tag ("5.0.0-beta.31" -> "5.0.31").
 *   3) SERVER_VERSION: explicit --server-version override, else read from
 *      version/version-details.json
 *      (files."server.js".url = https://dl.strem.io/server/<ver>/desktop/server.js).
 *   4) Bumps project(stremio VERSION) in CMakeLists.txt and APP_VERSION in
 *      src/core/globals.h, so the built binaries and NSIS metadata agree
 *      (release step 1 of docs/RELEASE.md, automated).
 ****************************************************/

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

function fail(msg) {
    console.error("ERROR: " + msg);
    process.exit(1);
}

function info(msg) {
    console.error("[ci_prepare] " + msg);
}

const argv = process.argv.slice(2);
const tag = argv[0];

if (!tag) {
    fail("Usage: node build/ci_prepare_release.js <GitTag> [--shell-version <v>] [--server-version <v>]");
}

let shellVersion = null;
let serverVersion = null;
for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--shell-version") shellVersion = argv[++i];
    else if (argv[i] === "--server-version") serverVersion = argv[++i];
    else fail("Unknown argument: " + argv[i]);
}

// 1) Tag validation
const tagMatch = tag.match(/^v?(\d+)\.(\d+)\.\d+-beta\.(\d+)$/);
if (!tagMatch && !shellVersion) {
    fail(`Tag "${tag}" does not match "<X.Y.Z>-beta.<N>" and no --shell-version override was given; cannot derive the shell version.`);
}
if (!/^v?\d+\.\d+\.\d+(-beta\.\d+)?$/.test(tag)) {
    info(`Warning: tag "${tag}" does not have the usual "<X.Y.Z>-beta.<N>" shape.`);
}

// 2) Shell version (derived or overridden)
if (!shellVersion) {
    shellVersion = `${tagMatch[1]}.${tagMatch[2]}.${tagMatch[3]}`;
    info(`Derived shell version ${shellVersion} from tag ${tag}`);
} else {
    info(`Using shell version override ${shellVersion}`);
}
if (!/^\d+\.\d+\.\d+$/.test(shellVersion)) {
    fail(`Shell version "${shellVersion}" is not <major>.<minor>.<patch>.`);
}

// 3) Server version (override or from the current manifest)
const detailsPath = path.join(projectRoot, "version", "version-details.json");
if (!fs.existsSync(detailsPath)) {
    fail("version/version-details.json not found; pass --server-version or restore it.");
}
const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
if (!serverVersion) {
    const url = (details.files && details.files["server.js"] && details.files["server.js"].url) || "";
    const m = url.match(/\/server\/(v?[\w.]+)\/desktop\//i);
    if (!m) {
        fail(`Could not derive the server.js version from version-details.json ("${url}"); pass --server-version.`);
    }
    serverVersion = m[1];
    info(`Using server.js version ${serverVersion} (from version-details.json)`);
} else {
    info(`Using server.js version override ${serverVersion}`);
}

// dl.strem.io only serves the "v"-prefixed path (a plainly pinned version
// as found in the current manifest 404s on every mirror). Normalize once so
// both the provisioning download and the published version-details.json URL
// point at something that actually resolves.
const bare = serverVersion.replace(/^v/i, "");
if ("v" + bare !== serverVersion) {
    info(`Normalized server.js version to ${"v" + bare} (dl.strem.io serves the v-prefixed path)`);
}
serverVersion = "v" + bare;

// 4) Version bumps
const cmakePath = path.join(projectRoot, "CMakeLists.txt");
let cmake = fs.readFileSync(cmakePath, "utf8");
const cmakeRe = /(project\s*\(\s*stremio\s+VERSION\s+)"?[\d.]+"?(\))/i;
if (!cmakeRe.test(cmake)) {
    fail("Could not find project(stremio VERSION ...) in CMakeLists.txt.");
}
cmake = cmake.replace(cmakeRe, `$1"${shellVersion}"$2`);
fs.writeFileSync(cmakePath, cmake, "utf8");
info(`CMakeLists.txt project version bumped to ${shellVersion}`);

const globalsPath = path.join(projectRoot, "src", "core", "globals.h");
let globals = fs.readFileSync(globalsPath, "utf8");
const appVersionRe = /(#define\s+APP_VERSION\s+")([^"]+)(")/;
if (!appVersionRe.test(globals)) {
    fail("Could not find the APP_VERSION define in src/core/globals.h.");
}
globals = globals.replace(appVersionRe, `$1${shellVersion}$3`);
fs.writeFileSync(globalsPath, globals, "utf8");
info(`globals.h APP_VERSION bumped to ${shellVersion}`);

// 5) Emit KEY=VALUE lines on stdout only
console.log(`GIT_TAG=${tag}`);
console.log(`SHELL_VERSION=${shellVersion}`);
console.log(`SERVER_VERSION=${serverVersion}`);
