const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { InvoicePdfPool } = require('../src/services/invoicePdfPool');
const workerPath = path.join(__dirname, 'fixtures/pdf-pool.worker.cjs');
const invoiceData = { SellerDtls: { LglNm: 'Worker Seller' }, BuyerDtls: { LglNm: 'Worker Buyer' }, DocDtls: { No: 'POOL-1' }, ItemList: [] };
const irnResponse = { SignedQRCode: 'worker-qr', Irn: 'worker-irn' };

test('bounded worker queue rejects overload and drains admitted work on shutdown', async () => {
    const pool = new InvoicePdfPool({ size: 1, maxQueue: 1, workerPath });
    try {
        const first = pool.run({ text: 'first', delay: 60 });
        const second = pool.run({ text: 'second' });
        await assert.rejects(pool.run({ text: 'excess' }), { statusCode: 503 });
        assert.equal(pool.workers.size, 1);
        const close = pool.close();
        await assert.rejects(pool.run({}), /shutting down/);
        assert.equal((await first).toString(), 'first');
        assert.equal((await second).toString(), 'second');
        await close;
        assert.equal(pool.workers.size, 0);
        await pool.close();
    } finally { await pool.close(); }
});
test('worker crash fails only its active job and replacement handles queued work', async () => {
    const pool = new InvoicePdfPool({ size: 1, workerPath });
    try {
        const failed = assert.rejects(pool.run({ mode: 'crash' }), { statusCode: 500 });
        const queued = pool.run({ text: 'recovered' });
        await failed;
        assert.equal((await queued).toString(), 'recovered');
        assert.equal(pool.workers.size, 1);
    } finally { await pool.close(); }
});
test('stuck worker is terminated at its deadline and replaced', async () => {
    const pool = new InvoicePdfPool({ size: 1, workerPath, timeoutMs: 1000 });
    try {
        await assert.rejects(pool.run({ mode: 'hang' }), { statusCode: 504 });
        assert.equal((await pool.run({ text: 'after-timeout' })).toString(), 'after-timeout');
    } finally { await pool.close(); }
});
test('CPU work runs without blocking timers on the main thread', async () => {
    const pool = new InvoicePdfPool({ size: 1, workerPath });
    const started = new SharedArrayBuffer(4);
    let finished = false;
    try {
        const task = pool.run({ mode: 'busy', started }).then(result => { finished = true; return result; });
        const deadline = Date.now() + 5000;
        while (!Atomics.load(new Int32Array(started), 0)) {
            assert.ok(Date.now() < deadline, 'worker did not start');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(finished, false);
        await task;
    } finally { await pool.close(); }
});
test('real workers generate PDFs, propagate validation errors, and remain reusable', async () => {
    const pool = new InvoicePdfPool({ size: 2 });
    try {
        await pool.warm();
        assert.equal(pool.workers.size, 2);
        const results = await Promise.all(Array.from({ length: 4 }, () => pool.run({ invoiceData, irnResponse })));
        for (const pdf of results) {
            assert.ok(Buffer.isBuffer(pdf));
            assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
            assert.ok(pdf.includes(Buffer.from('%%EOF')));
        }
        await assert.rejects(pool.run({ invoiceData: {}, irnResponse }), { statusCode: 400 });
        assert.equal((await pool.run({ invoiceData, irnResponse })).subarray(0, 5).toString(), '%PDF-');
    } finally { await pool.close(); }
});
test('worker configuration requires positive integer bounds', () => {
    for (const size of [0, -1, NaN, 1.5]) assert.throws(() => new InvoicePdfPool({ size }));
});
