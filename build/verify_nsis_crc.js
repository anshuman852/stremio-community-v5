#!/usr/bin/env node
/****************************************************
 * verify_nsis_crc.js
 *
 * Usage:
 *   node verify_nsis_crc.js <installer.exe> [more installers...]
 *
 * Byte-exact simulation of the NSIS 3.x installer integrity check
 * (via build/nsis_checker.js, implementing exehead fileform.c
 * loadHeaders()). Verifies installers WITHOUT executing them:
 *
 *   PASS = NSIS would run the installer normally.
 *   FAIL = NSIS would abort with "Installer integrity check has
 *          failed" on every machine (deterministic on the bytes).
 *
 * Exit code: 0 = all PASS, 1 = at least one FAIL.
 ****************************************************/

const fs = require("fs");
const { FH_FLAGS_UNINSTALL, FH_FLAGS_SILENT, FH_FLAGS_NO_CRC, FH_FLAGS_FORCE_CRC, FH_FLAGS_MASK } = require("./nsis_crc");
const { simulateNsIntegrityCheck } = require("./nsis_checker");

function flagNames(flags) {
    return [
        (flags & FH_FLAGS_UNINSTALL) ? "UNINSTALL" : null,
        (flags & FH_FLAGS_SILENT) ? "SILENT" : null,
        (flags & FH_FLAGS_NO_CRC) ? "NO_CRC" : null,
        (flags & FH_FLAGS_FORCE_CRC) ? "FORCE_CRC" : null
    ].filter(Boolean).join("|") || "none";
}

function verifyFile(file) {
    const buf = fs.readFileSync(file);
    const r = simulateNsIntegrityCheck(buf, buf.length);
    const base = `header@${r.hs ?? "-"} flags(${r.flags != null ? flagNames(r.flags) : "-"}) loa=${r.loa ?? "-"} fileSize=${buf.length}`;
    if (r.pass) {
        if (r.noCrc) {
            console.log(`PASS     ${file} ${base}: NO_CRC flag set; the stub does not run the CRC check.`);
        } else {
            console.log(`PASS     ${file} ${base}`);
            console.log(`         CRC ${r.computed.toString(16)} over [${r.crcRange[0]},${r.crcRange[1]}) == stored ${r.stored.toString(16)}`);
        }
        return true;
    }
    console.log(`FAIL     ${file} ${base}`);
    console.log(`         ${r.reason ?? "integrity mismatch"} -> NSIS aborts with "Installer integrity check has failed"`);
    return false;
}

let ok = true;
for (const file of process.argv.slice(2)) {
    try {
        if (!verifyFile(file)) ok = false;
    } catch (e) {
        console.error(`FAIL     ${file}: ${e.message}`);
        ok = false;
    }
}
process.exit(ok ? 0 : 1);
