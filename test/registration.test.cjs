const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.MONGODB_DB = `RegistrationRegression_${Date.now()}`;
process.env.REGISTRATION_MAX_INFLIGHT = '1000';
const logger = require('../src/utils/Logger');
logger.info = logger.warn = logger.error = () => {};
const { connectDB } = require('../src/config/database');
const { ensureUserIndexes } = require('../src/config/userIndexes');
const app = require('../app');
const User = require('../src/models/User');
const InvoiceSeriesHistory = require('../src/models/InvoiceSeriesHistory');
let server, url, sequence = 0;
function payload(overrides = {}) {
    const i = ++sequence;
    return {
        MobileNumber: String(917000000000 + i), Gstin: `07${String(i).padStart(9, '0')}ABC1`, InvoiceSeries: `UX${i}`,
        BankDetails: { BankName: 'Regression Bank', AccountNumber: '1234567890', IFSCCode: 'TEST0001234' },
        ...overrides,
    };
}
async function post(body) {
    const response = await fetch(`${url}/user-details`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}
before(async () => {
    await connectDB();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
});
for (const [field, value] of [['Gstin', '07999999999ABC1'], ['MobileNumber', '919999999999'], ['InvoiceSeries', 'RACE-SERIES']]) {
    test(`concurrent registrations sharing only ${field} create exactly one user`, async () => {
        const responses = await Promise.all(Array.from({ length: 20 }, () => post(payload({ [field]: value }))));
        assert.equal(responses.filter(r => r.status === 201).length, 1);
        const conflicts = responses.filter(r => r.status === 409);
        assert.equal(conflicts.length, 19);
        assert.ok(conflicts.every(r => r.body.Fields.includes(field)));
        assert.equal(await User.countDocuments({ [field]: value }), 1);
    });
}
test('GSTIN and invoice-series case variants cannot bypass uniqueness', async () => {
    assert.equal((await post(payload({ Gstin: '07999999999abc1' }))).status, 409);
    const result = await post(payload({ InvoiceSeries: 'race-series' }));
    assert.equal(result.status, 409);
    assert.deepEqual(result.body.Fields, ['InvoiceSeries']);
});
test('optional GSTIN and series can be omitted by multiple users', async () => {
    for (let i = 0; i < 2; i++) {
        const body = payload(); delete body.Gstin; delete body.InvoiceSeries;
        assert.equal((await post(body)).status, 201);
    }
});
test('invoice-series update cannot take another users series', async () => {
    const a = payload(), b = payload(); await post(a); await post(b);
    const response = await fetch(`${url}/user-details/invoice-series`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ MobileNumber: a.MobileNumber, InvoiceSeries: b.InvoiceSeries.toLowerCase() }),
    });
    assert.equal(response.status, 409);
    assert.equal((await User.findOne({ MobileNumber: a.MobileNumber })).InvoiceSeries, a.InvoiceSeries);
    assert.equal(await InvoiceSeriesHistory.countDocuments(), 0);
});
test('index rollout rejects existing duplicates without deleting data', async () => {
    const collection = mongoose.connection.db.collection('duplicate_index_probe');
    await collection.insertMany([
        { id: 'one', MobileNumber: 'one', InvoiceSeries: 'Same' },
        { id: 'two', MobileNumber: 'two', InvoiceSeries: 'same' },
    ]);
    await assert.rejects(ensureUserIndexes(collection), error => error.code === 11000);
    assert.equal(await collection.countDocuments(), 2);
});

test('registration stores the original logo URL without fetching it or writing a local logo', async () => {
    const http = require('node:http');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const dir = path.resolve(__dirname, '../uploads/logos');
    const before = (await fs.readdir(dir).catch(() => [])).sort();
    let fetches = 0;
    const remote = http.createServer((req, res) => { fetches++; res.writeHead(500); res.end(); });
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
    try {
        const sourceUrl = `http://127.0.0.1:${remote.address().port}/s3-logo.png`;
        const body = payload({ LogoS3Url: sourceUrl });
        assert.equal((await post(body)).status, 201);
        assert.equal((await User.findOne({ MobileNumber: body.MobileNumber })).LogoS3Url, sourceUrl);
        assert.equal(fetches, 0);
        assert.deepEqual((await fs.readdir(dir).catch(() => [])).sort(), before);
    } finally { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
});
