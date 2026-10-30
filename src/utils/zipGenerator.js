const crcTable = new Uint32Array(256).map((_, index) => {
    let crc = index;

    for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }

    return crc >>> 0;
});

function getCrc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date();
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    return { dosDate, dosTime };
}

function createLocalFileHeader(entry, offset) {
    const { dosDate, dosTime } = getDosDateTime(entry.modifiedAt);
    const header = Buffer.alloc(30);

    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.buffer.length, 18);
    header.writeUInt32LE(entry.buffer.length, 22);
    header.writeUInt16LE(entry.nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);

    return {
        offset,
        parts: [header, entry.nameBuffer, entry.buffer],
    };
}

function createCentralDirectoryHeader(entry, localHeaderOffset) {
    const { dosDate, dosTime } = getDosDateTime(entry.modifiedAt);
    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.buffer.length, 20);
    header.writeUInt32LE(entry.buffer.length, 24);
    header.writeUInt16LE(entry.nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localHeaderOffset, 42);

    return Buffer.concat([header, entry.nameBuffer]);
}

function createEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
    const header = Buffer.alloc(22);

    header.writeUInt32LE(0x06054b50, 0);
    header.writeUInt16LE(0, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(entryCount, 8);
    header.writeUInt16LE(entryCount, 10);
    header.writeUInt32LE(centralDirectorySize, 12);
    header.writeUInt32LE(centralDirectoryOffset, 16);
    header.writeUInt16LE(0, 20);

    return header;
}

function createZipBuffer(entries) {
    const preparedEntries = entries.map((entry) => ({
        ...entry,
        nameBuffer: Buffer.from(entry.name),
        crc: getCrc32(entry.buffer),
    }));
    const fileParts = [];
    const centralDirectoryParts = [];
    let offset = 0;

    preparedEntries.forEach((entry) => {
        const localFile = createLocalFileHeader(entry, offset);
        const localFileBuffer = Buffer.concat(localFile.parts);

        fileParts.push(localFileBuffer);
        centralDirectoryParts.push(createCentralDirectoryHeader(entry, localFile.offset));
        offset += localFileBuffer.length;
    });

    const centralDirectoryOffset = offset;
    const centralDirectory = Buffer.concat(centralDirectoryParts);
    const endOfCentralDirectory = createEndOfCentralDirectory(
        preparedEntries.length,
        centralDirectory.length,
        centralDirectoryOffset
    );

    return Buffer.concat([...fileParts, centralDirectory, endOfCentralDirectory]);
}

module.exports = { createZipBuffer };
