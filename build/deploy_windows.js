#!/usr/bin/env node

/****************************************************************************
 * deploy_windows.js
 *
 * Builds the windows distributable folder dist/win-<arch>.
 * Pass --installer to also build the windows installer (NSIS)
 * Pass --portable to also build the portable 7-Zip archive
 * Pass --installer --portable to build both from the same prepared dist
 *   (installer first; the WebView runtime is staged only during the later
 *   portable step, so the installer output stays clean).
 *
 * Optional environment:
 *   STREMIO_COMPILER_LAUNCHER - compiler launcher (e.g. sccache) forwarded to
 *                               CMake; sccache also enables cacheable MSVC
 *                               debug-info settings (CMake >= 3.25).
 *   STREMIO_VERBOSE_COPY=1    - per-file "Copied:" logging (default off).
 *   STREMIO_7Z_LEVEL=0..9     - 7-Zip compression level (default 7).
 *
 * Per-stage start/end/duration + resource snapshots (CPU count, total/free
 * RAM in GiB) are logged to the console and to build/logs/build-<arch>-<timestamp>.log.
 *
 * Make sure to have set up utils/windows and the environment correctly by
 * following windows.md
 *
 ****************************************************************************/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------
// Project/Layout Configuration
// ---------------------------------------------------------------------
const ARCH = process.argv.includes('--x86') ? 'x86' : 'x64';
const SOURCE_DIR = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(SOURCE_DIR, `cmake-build-release-${ARCH}`);
const DIST_DIR = path.join(SOURCE_DIR, 'dist', `win-${ARCH}`);
const CONFIG_DIR = path.join(SOURCE_DIR, 'dist', `win-${ARCH}`, 'portable_config');
const LOG_DIR = path.join(SOURCE_DIR, 'build', 'logs');
const PROJECT_NAME = 'stremio';

// Paths to Additional Dependencies
const MPV_DLL = ARCH === 'x86'
    ? path.join(SOURCE_DIR, 'deps', 'libmpv', 'i686', 'libmpv-2.dll')
    : path.join(SOURCE_DIR, 'deps', 'libmpv', 'x86_64', 'libmpv-2.dll');
const SERVER_JS = path.join(SOURCE_DIR, 'utils', 'windows', 'server.js');
const STREMIO_RUNTIME_EXE = path.join(SOURCE_DIR, 'utils', 'windows', 'stremio-runtime.exe');
const FFMPEG_FOLDER = path.join(SOURCE_DIR, 'utils', 'windows', 'ffmpeg');
const MPV_FOLDER = path.join(SOURCE_DIR, 'utils', 'mpv', 'anime4k');
const DEFAULT_SETTINGS_FOLDER = path.join(SOURCE_DIR, 'utils', 'stremio');
const WEBMODS_FOLDER = path.join(SOURCE_DIR, 'utils', 'webmods');

// Default Paths
const DEFAULT_NSIS = 'C:\\Users\\anshu\\scoop\\shims\\makensis.exe';
// VCPKG
const VCPKG_TRIPLET = ARCH === 'x86' ? 'x86-windows-static' : 'x64-windows-static';
const VCPKG_CMAKE = 'C:\\Users\\anshu\\vcpkg\\scripts\\buildsystems\\vcpkg.cmake';

// ---------------------------------------------------------------------
// Per-stage logging (console + build/logs/build-<arch>-<timestamp>.log)
// ---------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

function timestampForFile() {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
           `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

const LOG_FILE = path.join(LOG_DIR, `build-${ARCH}-${timestampForFile()}.log`);
let LOG_STREAM = null;

function log(message, isError) {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (isError) console.error(message); else console.log(message);
    if (LOG_STREAM) LOG_STREAM.write(line + '\n');
}

function formatDuration(ms) {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${(s % 60).toFixed(1)}s`;
}

// Logical CPU count + total/free RAM in GiB (Node `os` module, no deps).
function resourceSnapshot() {
    try {
        const cpus = os.cpus().length;
        const totalGiB = os.totalmem() / 1073741824;
        const freeGiB = os.freemem() / 1073741824;
        return `cpus=${cpus} total_ram=${totalGiB.toFixed(1)}GiB free_ram=${freeGiB.toFixed(1)}GiB`;
    } catch (e) {
        return 'resources=unavailable';
    }
}

// Runs a stage with start/end/failure timing + resource snapshot; failures
// are logged with their duration and rethrown to the caller.
function runStage(name, fn) {
    const started = Date.now();
    log(`\n=== STAGE START: ${name} ===`);
    try {
        const result = fn();
        log(`=== STAGE END: ${name} (${formatDuration(Date.now() - started)}) ===`);
        log(`    resources: ${resourceSnapshot()}`);
        return result;
    } catch (err) {
        log(`=== STAGE FAILED: ${name} (after ${formatDuration(Date.now() - started)}) ===`, true);
        log(`    resources: ${resourceSnapshot()}`, true);
        throw err;
    }
}

// Optional environment tuning
const VERBOSE_COPY = process.env.STREMIO_VERBOSE_COPY === '1';

let SEVENZ_LEVEL = 7;
if (process.env.STREMIO_7Z_LEVEL !== undefined && process.env.STREMIO_7Z_LEVEL !== '') {
    const raw = String(process.env.STREMIO_7Z_LEVEL).trim();
    if (/^\d{1,2}$/.test(raw)) {
        const parsed = parseInt(raw, 10);
        if (parsed >= 0 && parsed <= 9) {
            SEVENZ_LEVEL = parsed;
        } else {
            console.warn(`[deploy] Invalid STREMIO_7Z_LEVEL "${raw}" (expected 0-9); using default 7.`);
        }
    } else {
        console.warn(`[deploy] Invalid STREMIO_7Z_LEVEL "${raw}" (expected 0-9); using default 7.`);
    }
}

// Parses a positive-integer environment override; returns the parsed value, or
// `fallback` when unset, and warns (keeping the fallback) on invalid input.
function parsePositiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const trimmed = String(raw).trim();
    if (/^\d+$/.test(trimmed)) {
        const parsed = parseInt(trimmed, 10);
        if (parsed > 0) return parsed;
    }
    console.warn(`[deploy] Invalid ${name} "${raw}" (expected a positive integer); using default.`);
    return fallback;
}

// null = unset -> keep the plain `ninja` command / `-mmt=on` default behavior.
const NINJA_JOBS = parsePositiveIntEnv('STREMIO_NINJA_JOBS', null);
const SEVENZ_THREADS = parsePositiveIntEnv('STREMIO_7Z_THREADS', null);

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
(async function main() {
    const totalStart = Date.now();
    try {
        // Set up the per-arch timestamped log first.
        fs.mkdirSync(LOG_DIR, { recursive: true });
        LOG_STREAM = fs.createWriteStream(LOG_FILE, { flags: 'a' });
        log(`\n=== Building for ${ARCH.toUpperCase()} ===`);
        log(`Log file: ${LOG_FILE}`);
        log(`resources: ${resourceSnapshot()}`);
        log(`settings: 7z_level=${SEVENZ_LEVEL} (STREMIO_7Z_LEVEL), 7z_threads=${SEVENZ_THREADS || 'on'} (STREMIO_7Z_THREADS), ninja_jobs=${NINJA_JOBS || 'default'} (STREMIO_NINJA_JOBS), verbose_copy=${VERBOSE_COPY ? 'on' : 'off'}`);

        const args = process.argv.slice(2);
        const buildInstaller = args.includes('--installer');
        const buildPortable = args.includes('--portable');
        const debugBuild = args.includes('--debug');

        // 1) CMake configure + Ninja compile/link
        if (!fs.existsSync(BUILD_DIR)) {
            fs.mkdirSync(BUILD_DIR, { recursive: true });
        }

        process.chdir(BUILD_DIR);
        runStage('CMake configure', () => {
            // Optional compiler launcher (e.g. sccache) set by build_msvc.bat.
            // The configure command is left untouched when the launcher is unset.
            const launcher = process.env.STREMIO_COMPILER_LAUNCHER || '';
            const configureArgs = [
                'cmake',
                '-G Ninja',
                `-DCMAKE_BUILD_TYPE=${debugBuild ? "Debug" : "Release"}`,
                `-DCMAKE_TOOLCHAIN_FILE=${VCPKG_CMAKE}`,
                `-DVCPKG_TARGET_TRIPLET=${VCPKG_TRIPLET}`
            ];
            if (launcher) {
                // Quote so paths with spaces survive the cmd.exe invocation;
                // strip any stray quotes from the value itself.
                const quoted = `"${launcher.replace(/"/g, '')}"`;
                configureArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${quoted}`);
                configureArgs.push(`-DCMAKE_CXX_COMPILER_LAUNCHER=${quoted}`);
                if (launcher.toLowerCase() === 'sccache') {
                    // Keep MSVC Debug/RelWithDebInfo cacheable (CMake >= 3.25).
                    configureArgs.push('-DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded');
                    configureArgs.push('-DCMAKE_POLICY_DEFAULT_CMP0141=NEW');
                }
                log(`Compiler launcher enabled: ${launcher}`);
            }
            configureArgs.push('..');
            execSync(configureArgs.join(' '), { stdio: 'inherit' });
        });
        runStage('Ninja compile/link', () => {
            const ninjaCmd = NINJA_JOBS ? `ninja -j ${NINJA_JOBS}` : 'ninja';
            execSync(ninjaCmd, { stdio: 'inherit' });
        });
        process.chdir(__dirname);

        // 2) Prepare dist (single staging pass shared by both packages)
        runStage('dist preparation/copy', () => {
            log(`\n=== Cleaning and creating ${DIST_DIR} ===`);
            safeRemove(DIST_DIR);
            fs.mkdirSync(DIST_DIR, { recursive: true });

            const builtExe = path.join(BUILD_DIR, `${PROJECT_NAME}.exe`);
            const distExe = path.join(DIST_DIR, `${PROJECT_NAME}.exe`);
            copyFile(builtExe, distExe);
            copyFile(MPV_DLL, path.join(DIST_DIR, path.basename(MPV_DLL)));
            copyFile(SERVER_JS, path.join(DIST_DIR, path.basename(SERVER_JS)));

            log('Flattening DS folder, stremio-runtime, ffmpeg...');
            copyFile(STREMIO_RUNTIME_EXE, path.join(DIST_DIR, 'stremio-runtime.exe'));
            copyFolderContents(FFMPEG_FOLDER, DIST_DIR);
            copyFolderContentsPreservingStructure(MPV_FOLDER, DIST_DIR);
            copyFolderContentsPreservingStructure(DEFAULT_SETTINGS_FOLDER, CONFIG_DIR);
            // .md is skipped: utils/webmods/AGENTS.md documents the webmods for
            // developers and must not ship inside the install.
            copyFolderContentsPreservingStructure(WEBMODS_FOLDER, path.join(CONFIG_DIR, 'webmods'), { skipExts: ['.md'] });

            log('\n=== dist\\win preparation complete. ===');
        });

        // 3) Packaging: installer first, then portable from the same dist.
        //    The WebView runtime is staged into portable_config only inside the
        //    portable step, so the installer output is not polluted by it.
        if (buildInstaller) {
            log('\n--installer detected: building NSIS installer...');
            // Extract the version first so we can set process.env before calling NSIS
            const version = getPackageVersionFromCMake();
            process.env.package_version = version;
            log(`Set package_version to: ${version}`);
            runStage('NSIS installer', () => buildNsisInstaller());
        }
        if (buildPortable) {
            log('\n--portable detected: building Portable...');
            runStage('portable 7-Zip', () => buildPortableZip());
        }

        log(`\nAll done! Total run: ${formatDuration(Date.now() - totalStart)}`);
        log(`resources: ${resourceSnapshot()}`);
    } catch (err) {
        log(`\n=== BUILD FAILED after ${formatDuration(Date.now() - totalStart)} ===`, true);
        log(`resources: ${resourceSnapshot()}`, true);
        console.error('Error in deploy_windows.js:', err);
        process.exitCode = 1;
    } finally {
        if (LOG_STREAM) {
            LOG_STREAM.end();
            LOG_STREAM = null;
        }
    }
})();

/****************************************************************************
 * Helper Functions
 ****************************************************************************/

function safeRemove(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

// Per-file logging only in verbose mode (STREMIO_VERBOSE_COPY=1); missing
// source files always warn regardless of mode.
function copyFile(src, dest) {
    if (!fs.existsSync(src)) {
        log(`Warning: missing file: ${src}`);
        return;
    }
    fs.copyFileSync(src, dest);
    if (VERBOSE_COPY) {
        log(`Copied: ${src} -> ${dest}`);
    }
}

/**
 * Recursively copies only the contents of "src" into "dest" (flattened).
 * If src has files/folders, they go directly into dest, rather than
 * creating a subfolder named src. Returns the number of files copied.
 */
function copyFolderContents(src, dest) {
    if (!fs.existsSync(src)) {
        log(`Warning: missing folder: ${src}`);
        return 0;
    }
    const stats = fs.statSync(src);
    if (!stats.isDirectory()) {
        log(`Warning: not a directory: ${src}`);
        return 0;
    }
    let count = 0;
    for (const item of fs.readdirSync(src)) {
        const srcItem = path.join(src, item);
        const itemStats = fs.statSync(srcItem);
        const destItem = path.join(dest, item);
        if (itemStats.isDirectory()) {
            count += copyFolderContents(srcItem, dest);
        } else {
            copyFile(srcItem, destItem);
            count++;
        }
    }
    if (!VERBOSE_COPY && count > 0) {
        log(`Copied folder: ${src} -> ${dest} (${count} files)`);
    }
    return count;
}

/**
 * Copies the contents of `src` into `dest` without flattening.
 * Subdirectories in `src` will be recreated in `dest`.
 * `options.skipExts` (e.g. ['.md']) drops files by extension, so developer docs
 * living next to shipped assets are not packaged.
 * Returns the number of files copied.
 */
function copyFolderContentsPreservingStructure(src, dest, options = {}) {
    if (!fs.existsSync(src)) {
        log(`Warning: missing folder: ${src}`);
        return 0;
    }

    const stats = fs.statSync(src);
    if (!stats.isDirectory()) {
        log(`Warning: not a directory: ${src}`);
        return 0;
    }

    // Ensure destination directory exists
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    let count = 0;
    const items = fs.readdirSync(src);

    for (const item of items) {
        const srcItem = path.join(src, item);
        const destItem = path.join(dest, item);
        const itemStats = fs.statSync(srcItem);

        if (itemStats.isDirectory()) {
            // Recursively copy subdirectories
            count += copyFolderContentsPreservingStructure(srcItem, destItem, options);
        } else {
            const skipExts = Array.isArray(options.skipExts) ? options.skipExts : [];
            const skipped = skipExts.includes(path.extname(srcItem).toLowerCase());
            if (!skipped && !srcItem.endsWith('zip') && !srcItem.endsWith('7z')) {
                // Copy files
                copyFile(srcItem, destItem);
                count++;
            }
        }
    }
    if (!VERBOSE_COPY && count > 0) {
        log(`Copied folder: ${src} -> ${dest} (${count} files)`);
    }
    return count;
}

/**
 * Retrieves version from CMakeLists.txt (handles quotes):
 *  project(stremio VERSION "5.0.2")
 */
function getPackageVersionFromCMake() {
    const cmakeFile = path.join(SOURCE_DIR, 'CMakeLists.txt');
    let version = '0.0.0';
    if (fs.existsSync(cmakeFile)) {
        const content = fs.readFileSync(cmakeFile, 'utf8');
        // Accept either quoted or unquoted numerical version
        const match = content.match(/project\s*\(\s*stremio\s+VERSION\s+"?([\d.]+)"?\)/i);
        if (match) {
            version = match[1];
        }
    }
    return version;
}

// Throws on real failures so the surrounding stage log reports them; missing
// NSIS is a soft skip (warning only), matching the previous behavior.
function buildNsisInstaller() {
    if (!fs.existsSync(DEFAULT_NSIS)) {
        log(`Warning: NSIS not found at default path: ${DEFAULT_NSIS}. Skipping installer.`);
        return;
    }
    const arch = process.argv.includes('--x86') ? 'x86' : 'x64'; // Determine architecture
    const distSubfolder = `win-${arch}`;

    const distFolder = path.join(SOURCE_DIR, 'dist', distSubfolder);
    if (!fs.existsSync(distFolder)) {
        throw new Error(`Distribution folder does not exist: ${distFolder}`);
    }

    const nsiScript = path.join(SOURCE_DIR, 'utils', 'windows', 'installer', 'windows-installer.nsi');
    log(`Running makensis.exe with version: ${process.env.package_version} ...`);
    process.env.arch = arch;
    execSync(`"${DEFAULT_NSIS}" "${nsiScript}"`, { stdio: 'inherit' });
    log(`\nInstaller created: "Stremio ${process.env.package_version}.exe"`);
}

// Throws on real failures so the surrounding stage log reports them.
function buildPortableZip() {
    const version = getPackageVersionFromCMake();
    const portableOutput = path.join(SOURCE_DIR, 'utils', `Stremio ${version}-${ARCH}.7z`);
    const fixedEdgeWebView = path.join(SOURCE_DIR, 'utils', 'windows', 'WebviewRuntime', ARCH);
    const portable_config = path.join(DIST_DIR, 'portable_config');
    const distContents = DIST_DIR; // Path to dist directory contents

    log(`\nCreating Portable ZIP: ${portableOutput}`);

    // Common 7-Zip paths (generic %USERPROFILE% scoop fallback; no hardcoded
    // user-specific path)
    const scoopShims = path.join(process.env.USERPROFILE || '', 'scoop', 'shims', '7z.exe');
    const common7zPaths = [
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
        scoopShims
    ];

    // Find 7-Zip executable
    const sevenZipPath = common7zPaths.find(fs.existsSync);
    if (!sevenZipPath) {
        throw new Error(
            '7-Zip executable not found in common paths.\n' +
            'Please install 7-Zip and ensure it is in one of the following paths:\n' +
            common7zPaths.join('\n')
        );
    }

    log(`Using 7-Zip at: ${sevenZipPath}`);

    // Ensure the DIST_DIR exists
    if (!fs.existsSync(DIST_DIR)) {
        throw new Error(`DIST_DIR does not exist: ${DIST_DIR}`);
    }

    // Snapshot the portable_config entries BEFORE staging the WebView runtime.
    // The runtime is copied flat into portable_config, so after 7-Zip we remove
    // exactly the entries that were added by the copy (diff against this
    // snapshot) — never the pre-existing mpv/settings/webmod files.
    const configEntriesBefore = snapshotDirEntries(portable_config);

    // Stage the WebView runtime into portable_config only for this archive
    copyFolderContentsPreservingStructure(fixedEdgeWebView, portable_config);

    // Remove any stale archive so removed files can never remain inside
    if (fs.existsSync(portableOutput)) {
        log(`Removing stale archive: ${portableOutput}`);
        fs.rmSync(portableOutput, { force: true });
    }

    // Command to create the 7z archive
    const threadsOpt = SEVENZ_THREADS ? `-mmt=${SEVENZ_THREADS}` : '-mmt=on';
    const zipCommand = `"${sevenZipPath}" a -t7z -mx=${SEVENZ_LEVEL} ${threadsOpt} -y "${portableOutput}" "${distContents}\\*"`;

    log(`Running: ${zipCommand}`);
    try {
        execSync(zipCommand, { stdio: 'inherit' });
        log(`\nPortable ZIP created: ${portableOutput}`);
    } finally {
        // Clean up exactly the staged WebView runtime entries on success and
        // on archive failure alike (failure is rethrown by the caller).
        const removed = removeStagedEntries(portable_config, configEntriesBefore);
        if (removed > 0) {
            log(`Cleaned up ${removed} staged WebView runtime entr${removed === 1 ? 'y' : 'ies'} from ${portable_config}`);
        } else {
            log(`No staged WebView runtime entries to clean up in ${portable_config}`);
        }
    }
}

/**
 * Returns the set of top-level entry names in `dir` (guarded; empty when the
 * directory is missing or unreadable). Used as a pre-copy snapshot so only the
 * entries staged by the WebView runtime copy are removed afterwards.
 */
function snapshotDirEntries(dir) {
    try {
        if (!dir || !fs.existsSync(dir)) return new Set();
        return new Set(fs.readdirSync(dir));
    } catch (e) {
        return new Set();
    }
}

/**
 * Removes exactly the top-level entries of `dir` that were NOT present in the
 * `beforeNames` snapshot (guarded; never touches pre-existing files). Returns
 * the number of entries removed.
 */
function removeStagedEntries(dir, beforeNames) {
    let removed = 0;
    if (!dir || !beforeNames) return 0;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return 0; }
    for (const name of names) {
        if (beforeNames.has(name)) continue; // pre-existing — not ours
        const entry = path.join(dir, name);
        try {
            const stats = fs.lstatSync(entry);
            if (stats.isDirectory()) {
                fs.rmSync(entry, { recursive: true, force: true });
            } else {
                fs.rmSync(entry, { force: true });
            }
            removed++;
        } catch (e) { /* guarded */ }
    }
    return removed;
}
