#!/usr/bin/env node
/****************************************************
 * nsis_crc.js - shared NSIS installer integrity logic.
 *
 * Implements the installer CRC check performed by NSIS 3.x's exehead
 * (Source/exehead/fileform.c, loadHeaders()), so tooling can verify or
 * repair an installer's integrity WITHOUT executing it:
 *
 *   - firstheader scan (siginfo 0xDEADBEEF + "NullsoftInst"), 512-byte
 *     steps from offset 0
 *   - CRC32 (poly 0xEDB88320, zlib convention) over
 *     [512, header_offset + length_of_all_following_data - 4):
 *     every 512-byte chunk except the very first one is hashed
 *     (chunk 0 is excluded by NSIS's `left < m_length` condition)
 *   - the 4-byte little-endian trailer read at the end of that window
 *     must equal the computed CRC
 ****************************************************/

const FH_SIG = 0xDEADBEEF;
const FH_INT1 = 0x6C6C754E; // "Null"
const FH_INT2 = 0x74666F73; // "soft"
const FH_INT3 = 0x74736E49; // "Inst"
const FH_FLAGS_UNINSTALL = 1, FH_FLAGS_SILENT = 2, FH_FLAGS_NO_CRC = 4, FH_FLAGS_FORCE_CRC = 8;
const FH_FLAGS_MASK = FH_FLAGS_UNINSTALL | FH_FLAGS_SILENT | FH_FLAGS_NO_CRC | FH_FLAGS_FORCE_CRC;

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(init, buf, start, end) {
    let c = init ^ (-1);
    for (let i = start; i < end; i++) {
        c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
    }
    return (c ^ (-1)) >>> 0;
}

const u32 = (buf, o) => buf.readUInt32LE(o);

/**
 * Locates the firstheader at a 512-byte-aligned offset. The header must
 * be fully inside [start, end). Returns { hs, flags, lengthOfHeader, loa }
 * with hs being the ABSOLUTE file offset, or null.
 */
function findNsisHeader(buf, start, end) {
    for (let pos = Math.max(0, start); pos + 28 <= end; pos += 512) {
        if (u32(buf, pos + 4) !== FH_SIG) continue;
        const flags = u32(buf, pos);
        if ((flags & ~FH_FLAGS_MASK) !== 0) continue;
        if (u32(buf, pos + 8) !== FH_INT1 || u32(buf, pos + 12) !== FH_INT2 || u32(buf, pos + 16) !== FH_INT3) continue;
        const lengthOfHeader = u32(buf, pos + 20);
        const loa = u32(buf, pos + 24);
        if (lengthOfHeader < 28 || loa < lengthOfHeader) continue;
        return { hs: pos, flags, lengthOfHeader, loa };
    }
    return null;
}

/**
 * Convenience: find the firstheader for a whole-file buffer. S is the
 * filesize; verification of loa vs S is the caller's job.
 */
function findNsisHeaderWhole(buf, S) {
    return findNsisHeader(buf, 0, Math.min(S, buf.length));
}

/**
 * Computes the CRC NSIS would calculate: CRC32 over [crcStart, crcEnd)
 * chained exactly the way loadHeaders() streams chunks (mathematically
 * identical to one call - kept as a single call for speed).
 */
function computeNsisCrc(buf, crcStart, crcEnd) {
    return crc32(0, buf, crcStart, crcEnd);
}

module.exports = {
    FH_SIG, FH_INT1, FH_INT2, FH_INT3,
    FH_FLAGS_UNINSTALL, FH_FLAGS_SILENT, FH_FLAGS_NO_CRC, FH_FLAGS_FORCE_CRC, FH_FLAGS_MASK,
    crc32, crcTable: CRC_TABLE,
    findNsisHeader, findNsisHeaderWhole, computeNsisCrc
};
