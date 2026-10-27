#!/usr/bin/env node
/****************************************************
 * fix_nsis_crc.js
 *
 * Usage:
 *   node fix_nsis_crc.js <installer.exe> [--out <path>]
 *     --out : write the repaired file to <path> (default:
 *             <installer>.crc-fixed.exe next to the original)
 *
 * Repairs an installer whose NSIS integrity footer is stale, i.e. one
 * that aborts with "Installer integrity check has failed" on every
 * machine. It:
 *   1) verifies the NSIS firstheader and that the data window spans
 *      header..EOF exactly (standard makensis output),
 *   2) recomputes NSIS's CRC32 (nsis_crc.js) over the bytes actually
 *      on disk,
 *   3) writes the (possibly corrected) 4-byte trailer, leaving every
 *      other byte untouched.
 *
 * This only reconciles the integrity footer with the file's content;
 * it does NOT rescue corrupted payload data. Validate separately:
 *   `7z t <file>` (full CRC decode test) before/after repairing.
 ****************************************************/

const fs = require("fs");
const { findNsisHeaderWhole, computeNsisCrc, FH_FLAGS_NO_CRC, FH_FLAGS_FORCE_CRC } = require("./nsis_crc");

function repairFile(file, outPath) {
    const buf = fs.readFileSync(file);
    const S = buf.length;

    const h = findNsisHeaderWhole(buf, S);
    if (!h) {
        console.error(`FAIL  ${file}: no valid NSIS firstheader found - not repairing.`);
        return false;
    }
    if (h.hs + h.loa !== S) {
        console.error(`FAIL  ${file}: length_of_all_following_data (${h.loa}) with header@${h.hs} must span header..EOF exactly ` +
            `(expected ${(S - h.hs)}, got ${h.loa}) - file is not a plain makensis output; needs manual analysis instead of a trailer rewrite.`);
        return false;
    }
    const trailerPos = h.hs + h.loa - 4;
    if (trailerPos < 512) {
        console.error(`FAIL  ${file}: CRC window would be empty/negative - refusing.`);
        return false;
    }
    const stored = buf.readUInt32LE(trailerPos);

    if ((h.flags & FH_FLAGS_FORCE_CRC) === 0 && (h.flags & FH_FLAGS_NO_CRC)) {
        console.log(`SKIP  ${file}: NO_CRC flag set - the stub never verifies CRC; nothing to repair.`);
        return true;
    }

    const computed = computeNsisCrc(buf, 512, trailerPos);
    if (computed === stored) {
        console.log(`OK    ${file}: NSIS CRC already consistent (0x${computed.toString(16)}) - nothing to do.`);
        // Still write the copy if an --out was requested.
        if (outPath !== file) fs.writeFileSync(outPath, buf);
        return true;
    }

    const out = Buffer.from(buf); // keep original bytes; replace only the trailer
    out.writeUInt32LE(computed, trailerPos);
    fs.writeFileSync(outPath, out);

    // Self-check the result
    const re = fs.readFileSync(outPath);
    const recomputed = computeNsisCrc(re, 512, trailerPos);
    const reStored = re.readUInt32LE(trailerPos);
    const pass = recomputed === reStored;
    console.log(`${pass ? "REPAIRED" : "FAIL "} ${file}: trailer offset ${trailerPos} was 0x${stored.toString(16)}, computed 0x${computed.toString(16)} -> wrote to ${outPath}`);
    console.log(`      verification: ${pass ? "PASS" : "FAIL"} (window [512,${trailerPos}))`);
    return pass;
}

(function main() {
    const argv = process.argv.slice(2);
    const outIdx = argv.indexOf("--out");
    let explicitOut = null;
    if (outIdx !== -1) { explicitOut = argv[outIdx + 1]; argv.splice(outIdx, 2); }
    if (argv.length < 1) {
        console.error("Usage: node fix_nsis_crc.js <installer.exe> [--out <path>]");
        process.exit(1);
    }
    let ok = true;
    for (const file of argv) {
        const out = explicitOut || file.replace(/\.exe$/i, "") + ".crc-fixed.exe";
        try {
            if (!repairFile(file, out)) ok = false;
        } catch (e) {
            console.error(`FAIL  ${file}: ${e.message}`);
            ok = false;
        }
    }
    process.exit(ok ? 0 : 1);
})();
