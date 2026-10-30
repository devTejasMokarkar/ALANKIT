const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { fetchLogoBuffer, createLogoBuffer } = require('../src/utils/pdfGenerator');

async function fixture(handler, run) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await run(`http://127.0.0.1:${server.address().port}/logo.png`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('complete image is fetched into memory without changing its bytes', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await fixture((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }, async url => {
        const result = await fetchLogoBuffer(url);
        assert.deepEqual(result.buffer, png);
        assert.equal(result.contentType, 'image/png');
    });
});

test('interrupted body rejects promptly instead of hanging', { timeout: 2000 }, async () => {
    await fixture((req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '100000' });
        res.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        setTimeout(() => res.destroy(), 30);
    }, async url => { await assert.rejects(fetchLogoBuffer(url), /interrupted|Unable to read/); });
});

test('continuously trickling body cannot evade the download deadline', { timeout: 13000 }, async () => {
    await fixture((req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        const timer = setInterval(() => res.write(Buffer.alloc(1)), 100);
        res.on('close', () => clearInterval(timer));
    }, async url => { await assert.rejects(fetchLogoBuffer(url), /timed out|interrupted|Unable to read/); });
});

test('redirects share one overall download deadline', { timeout: 12500 }, async () => {
    let first = true;
    await fixture((req, res) => {
        if (first) {
            first = false;
            const timer = setTimeout(() => { res.writeHead(302, { Location: '/redirected.png' }); res.end(); }, 6000);
            res.on('close', () => clearTimeout(timer));
        } else {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            const timer = setInterval(() => res.write(Buffer.alloc(1)), 100);
            res.on('close', () => clearInterval(timer));
        }
    }, async url => { await assert.rejects(fetchLogoBuffer(url), /timed out|interrupted|Unable to read/); });
});

test('image and PDF logos render in memory without creating logo or temporary files', async () => {
    const sharp = require('sharp');
    const PDFDocument = require('pdfkit');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2563eb' } }).png().toBuffer();
    const pdf = await new Promise(resolve => {
        const chunks = [], doc = new PDFDocument({ size: [80, 40], margin: 0 });
        doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.rect(0, 0, 80, 40).fill('blue'); doc.end();
    });
    const originals = { writeFile: fs.writeFile, mkdtemp: fs.mkdtemp, rm: fs.rm };
    for (const key of Object.keys(originals)) fs[key] = async () => { assert.fail(`Logo processing attempted fs.${key}`); };
    try {
        for (const [buffer, mime] of [[png, 'image/png'], [pdf, 'application/pdf']]) {
            let downloads = 0;
            await fixture((req, res) => { downloads++; res.writeHead(200, { 'Content-Type': mime }); res.end(buffer); }, async url => {
                const logos = await Promise.all(Array.from({ length: 10 }, () => createLogoBuffer(url)));
                assert.equal(downloads, 1);
                for (const logo of logos) {
                    assert.ok(Buffer.isBuffer(logo));
                    assert.equal(logo.subarray(1, 4).toString(), 'PNG');
                }
            });
        }
    } finally { for (const [key, fn] of Object.entries(originals)) fs[key] = fn; }
});
