#!/usr/bin/env node
/****************************************************
 * nsis_checker.js - high-level NSIS installer integrity verifier.
 *
 * verifyNsisFile(file) -> boolean
 *   true  = NSIS would accept the file (no integrity dialog)
 *   false = NSIS would show "Installer integrity check has failed"
 *
 * Wraps nsis_crc.js primitives with the exact control flow of
 * NSIS's loadHeaders() CRC path (see fileform.c):
 *   - scan firstheader in 512-byte steps from offset 0
 *   - skip hashing of chunk 0 (`left < m_length` on first iteration)
 *   - hash chunks [.., end of loa-4 window) with zlib-convention CRC32
 *   - read the 4-byte LE trailer at the seek point and compare
 ****************************************************/

const fs = require("fs");
const {
    FH_FLAGS_UNINSTALL, FH_FLAGS_SILENT, FH_FLAGS_NO_CRC, FH_FLAGS_FORCE_CRC, FH_FLAGS_MASK,
    crc32, findNsisHeader
} = require("./nsis_crc");

/**
 * Exact control-flow replica of loadHeaders()'s CRC path.
 * Returns a result object; `pass === true` means NSIS accepts the file.
 */
function simulateNsIntegrityCheck(buf, S) {
    let m_pos = 0;        // cumulative consumed bytes (== current file offset)
    let left = S;         // m_length initially; becomes loa-4 after the header
    let crc = 0;
    let h = null;         // firstheader once found
    let do_crc = false;
    let crcStart = null;  // first hashed file offset

    while (left > 0) {
        const l = Math.min(left, h ? 32768 : 512);

        if (!h) {
            h = findNsisHeader(buf, m_pos, m_pos + l);
            if (h) {
                if (h.loa > left)  // loa > remaining bytes
                    return { pass: false, reason: `length_of_all_following_data (${h.loa}) exceeds remaining file bytes (${left})`, hs: h.hs, flags: h.flags, loa: h.loa };
                if ((h.flags & FH_FLAGS_FORCE_CRC) === 0 && (h.flags & FH_FLAGS_NO_CRC))
                    return { pass: true, noCrc: true, hs: h.hs, flags: h.flags, loa: h.loa };
                do_crc = true;
                left = h.loa - 4;   // NSIS_CONFIG_CRC_ANAL off: end CRC at the trailer
            }
        }

        // "if (left < m_length) crc = CRC32(crc, temp, l);"
        if (left < S) {
            if (crcStart === null) crcStart = m_pos;
            crc = crc32(crc, buf, m_pos, m_pos + l);
        }

        m_pos += l;
        left -= l;
    }

    if (!h) return { pass: false, reason: "no valid NSIS firstheader found" };
    if (!do_crc) return { pass: true, noCrc: true, hs: h.hs, flags: h.flags, loa: h.loa };

    // NSIS: SetSelfFilePointer(m_pos); ReadSelfFile(&fcrc, 4); crc != fcrc -> invalid
    if (m_pos + 4 > S) return { pass: false, reason: "file ends before the CRC trailer", hs: h.hs, flags: h.flags, loa: h.loa };
    const stored = buf.readUInt32LE(m_pos);
    return {
        pass: crc === stored,
        hs: h.hs, flags: h.flags, loa: h.loa,
        crcRange: [crcStart, m_pos],
        computed: crc, stored
    };
}

/** Verify one file. Returns true iff NSIS would accept it. */
function verifyNsisFile(file) {
    const buf = fs.readFileSync(file);
    return simulateNsIntegrityCheck(buf, buf.length).pass;
}

module.exports = { simulateNsIntegrityCheck, verifyNsisFile };
