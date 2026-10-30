const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInvoiceGate } = require('../src/middleware/InvoiceGate');
function response() {
    return { locals: {}, headers: {}, setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
test('invoice overload rejects work before starting and disconnected clients retain their slots', async () => {
    const gate = createInvoiceGate({ maxInFlight: 1 });
    const first = response();
    gate({}, first, () => {});
    first.destroyed = true;
    const busy = response();
    gate({}, busy, () => assert.fail('overloaded invoice was admitted'));
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.body.code, 'INVOICE_BUSY');
    assert.equal(busy.headers['Retry-After'], '1');
    let drained = false;
    const drain = gate.waitForIdle().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    first.locals.releaseInvoice();
    first.locals.releaseInvoice();
    await drain;
    assert.equal(drained, true);
    const second = response();
    gate({}, second, () => {});
    const third = response();
    gate({}, third, () => assert.fail('double release increased capacity'));
    assert.equal(third.statusCode, 503);
    second.locals.releaseInvoice();
});
test('invoice controller releases capacity after validation failure', async () => {
    const { generateInvoice } = require('../src/controllers/InvoiceController');
    const gate = createInvoiceGate({ maxInFlight: 1 });
    const res = response();
    gate({}, res, () => {});
    await generateInvoice({ body: {} }, res, error => { throw error; });
    assert.equal(res.statusCode, 400);
    let admitted = false;
    const next = response();
    gate({}, next, () => { admitted = true; });
    assert.equal(admitted, true);
    next.locals.releaseInvoice();
});
test('invalid invoice capacity fails explicitly', () => {
    for (const maxInFlight of [0, -1, NaN, 1.5]) assert.throws(() => createInvoiceGate({ maxInFlight }));
});
