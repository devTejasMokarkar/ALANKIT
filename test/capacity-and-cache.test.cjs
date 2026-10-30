const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogoCache } = require('../src/utils/LogoCache');
const { createRegistrationGate } = require('../src/middleware/RegistrationGate');

test('concurrent requests for one logo share a single in-memory download', async () => {
    let downloads = 0;
    const get = createLogoCache(async () => { downloads++; await new Promise(r => setTimeout(r, 20)); return Buffer.from('png-bytes'); });
    const results = await Promise.all(Array.from({ length: 100 }, () => get('same-signed-url')));
    assert.equal(downloads, 1);
    assert.ok(results.every(r => r.toString() === 'png-bytes'));
    await get('same-signed-url'); assert.equal(downloads, 1);
});
test('logo errors are briefly cached, then retried; expired entries reload', async () => {
    let attempts = 0;
    const get = createLogoCache(async () => { if (++attempts === 1) throw new Error('remote failed'); return 'ok'; }, { failureTtlMs: 20, ttlMs: 20 });
    await assert.rejects(get('url'), /remote failed/);
    await assert.rejects(get('url'), /remote failed/);
    assert.equal(attempts, 1);
    await new Promise(r => setTimeout(r, 30)); assert.equal(await get('url'), 'ok');
    await new Promise(r => setTimeout(r, 30)); assert.equal(await get('url'), 'ok'); assert.equal(attempts, 3);
});
function response() {
    return { locals: {}, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
test('capacity remains occupied until controller releases work, including a disconnected client', () => {
    const gate = createRegistrationGate({ maxInFlight: 1 }); let admitted = 0;
    const first = response(); gate({}, first, () => admitted++); first.destroyed = true;
    const busy = response(); gate({}, busy, () => admitted++);
    assert.equal(busy.statusCode, 503); assert.equal(busy.headers['Retry-After'], '1'); assert.equal(admitted, 1);
    first.locals.releaseRegistration(); first.locals.releaseRegistration();
    gate({}, response(), () => admitted++); assert.equal(admitted, 2);
    const stillBusy = response(); gate({}, stillBusy, () => admitted++); assert.equal(stillBusy.statusCode, 503);
});
test('configured rate limit returns an explicit 429', () => {
    const gate = createRegistrationGate({ maxInFlight: 10, ratePerSecond: 1 });
    gate({}, response(), () => {});
    const limited = response(); gate({}, limited, () => assert.fail('rate limit bypassed'));
    assert.equal(limited.statusCode, 429);
});

test('shutdown drain waits for registration work after its client disconnects', async () => {
    const gate = createRegistrationGate({ maxInFlight: 1 });
    const res = response(); gate({}, res, () => {}); res.destroyed = true;
    let idle = false;
    const drained = gate.waitForIdle().then(() => { idle = true; });
    await Promise.resolve(); assert.equal(idle, false);
    res.locals.releaseRegistration(); await drained; assert.equal(idle, true);
});
