const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { uploadInvoicePdf, readInvoicePdf } = require('../src/services/invoiceStorage');
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
afterEach(() => { global.fetch = originalFetch; process.env = { ...originalEnv }; });
function configure() {
    process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
    process.env.CLOUDINARY_API_KEY = 'test-key';
    process.env.CLOUDINARY_API_SECRET = 'test-secret';
}
test('uploads PDF bytes with a signed raw upload and returns its cloud location', async () => {
    configure();
    global.fetch = async (url, options) => {
        assert.equal(url, 'https://api.cloudinary.com/v1_1/test-cloud/raw/upload');
        assert.equal(options.method, 'POST');
        const form = options.body;
        assert.equal(await form.get('file').text(), '%PDF-test');
        assert.equal(form.get('file').type, 'application/pdf');
        assert.equal(form.get('overwrite'), 'false');
        const expected = crypto.createHash('sha1').update(`overwrite=false&public_id=invoices/test.pdf&timestamp=${form.get('timestamp')}test-secret`).digest('hex');
        assert.equal(form.get('signature'), expected);
        assert.equal(form.get('api_key'), 'test-key');
        assert.equal(form.has('api_secret'), false);
        return { ok: true, json: async () => ({ secure_url: 'https://res.cloudinary.com/test-cloud/raw/upload/test.pdf', public_id: 'invoices/test.pdf' }) };
    };
    assert.equal((await uploadInvoicePdf(Buffer.from('%PDF-test'), 'test.pdf')).publicId, 'invoices/test.pdf');
});
test('missing configuration and upload failures are errors without leaking credentials', async () => {
    for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_URL']) delete process.env[key];
    await assert.rejects(uploadInvoicePdf(Buffer.from('pdf'), 'test.pdf'), { statusCode: 500 });
    configure();
    global.fetch = async () => { throw new Error('test-secret'); };
    await assert.rejects(uploadInvoicePdf(Buffer.from('pdf'), 'test.pdf'), { statusCode: 502, message: 'Cloudinary invoice upload failed' });
});
test('ZIP readers fetch Cloudinary PDFs and retain support for existing local invoices', async () => {
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('cloud-pdf') });
    assert.equal((await readInvoicePdf({ RelativeUrl: 'https://res.cloudinary.com/test/raw/upload/test.pdf' })).toString(), 'cloud-pdf');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'invoice-test-'));
    try {
        const file = path.join(dir, 'legacy.pdf');
        await fs.writeFile(file, 'legacy-pdf');
        assert.equal((await readInvoicePdf({ RelativeUrl: '/uploads/legacy.pdf' }, file)).toString(), 'legacy-pdf');
    } finally { await fs.rm(dir, { recursive: true }); }
    global.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(readInvoicePdf({ RelativeUrl: 'https://res.cloudinary.com/test/raw/upload/missing.pdf' }), { code: 'ENOENT' });
    await assert.rejects(readInvoicePdf({ RelativeUrl: 'https://example.com/private' }), /Invalid stored invoice URL/);
});
test('PDF generation returns bytes without creating a local invoice file', async () => {
    const { generateInvoicePdf } = require('../src/utils/pdfGenerator');
    const fsSync = require('node:fs');
    const originalWrite = fsSync.createWriteStream;
    fsSync.createWriteStream = () => assert.fail('invoice written to disk');
    try {
        const buffer = await generateInvoicePdf({
            invoiceData: { SellerDtls: { LglNm: 'Test Seller' }, BuyerDtls: { LglNm: 'Test Buyer' }, DocDtls: { No: 'TEST-1' }, ItemList: [] },
            irnResponse: { SignedQRCode: 'test-qr', Irn: 'test-irn' },
        });
        assert.ok(Buffer.isBuffer(buffer));
        assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    } finally { fsSync.createWriteStream = originalWrite; }
});
test('concurrent invoice requests persist distinct Cloudinary URLs and upload failures create no record', async () => {
    configure();
    const User = require('../src/models/User');
    const Invoice = require('../src/models/Invoice');
    const { generateInvoiceMedia } = require('../src/services/invoice.service');
    const originals = { findOne: User.findOne, create: Invoice.create };
    const records = [];
    User.findOne = () => ({ lean: async () => ({ id: 'test-user' }) });
    Invoice.create = async record => { records.push(record); return record; };
    global.fetch = async (_url, options) => ({ ok: true, json: async () => ({
        secure_url: `https://res.cloudinary.com/test-cloud/raw/upload/${options.body.get('public_id')}`,
        public_id: options.body.get('public_id'),
    }) });
    const invoiceData = { SellerDtls: {}, BuyerDtls: {}, DocDtls: { No: 'TEST' }, ItemList: [] };
    const request = {
        mobileNumber: '919999999999', gstin: '07AAAAAAAAAA1Z1',
        invoiceResponse: { AckNo: '1', AckDt: '2026-10-30', Irn: 'test', Status: 'ACT', SignedQRCode: 'test',
            SignedInvoice: `e30.${Buffer.from(JSON.stringify(invoiceData)).toString('base64url')}.test` },
    };
    try {
        const results = await Promise.all(Array.from({ length: 10 }, () => generateInvoiceMedia(request)));
        assert.equal(new Set(results.map(result => result.fileName)).size, 10);
        assert.equal(records.length, 10);
        for (const result of results) {
            assert.ok(result.relativeUrl.startsWith('https://res.cloudinary.com/'));
            assert.equal(records.find(record => record.InvoiceId === result.invoiceId).RelativeUrl, result.relativeUrl);
        }
        const { generateInvoice } = require('../src/controllers/InvoiceController');
        const { createInvoiceGate } = require('../src/middleware/InvoiceGate');
        const gate = createInvoiceGate({ maxInFlight: 1 });
        const res = { locals: {}, headers: {}, setHeader(key, value) { this.headers[key] = value; },
            status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        gate({}, res, () => {});
        await generateInvoice({ body: { MobileNumber: request.mobileNumber, Gstin: request.gstin, invoiceResponse: request.invoiceResponse },
            get: () => 'localhost:8081' }, res, error => { throw error; });
        assert.equal(res.statusCode, 201);
        assert.ok(res.body.mediaUrl.startsWith('https://res.cloudinary.com/'));
        for (const stage of ['invoice_user_lookup', 'invoice_pdf', 'invoice_cloudinary_upload', 'invoice_mongo_insert']) {
            assert.match(res.headers['Server-Timing'], new RegExp(stage + ';dur=[0-9]+'));
        }
        await gate.waitForIdle();
        assert.equal(records.length, 11);
        global.fetch = async () => ({ ok: false, status: 500 });
        await assert.rejects(generateInvoiceMedia(request), { statusCode: 502 });
        assert.equal(records.length, 11);
    } finally { User.findOne = originals.findOne; Invoice.create = originals.create; }
});
