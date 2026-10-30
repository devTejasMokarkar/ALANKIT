const { parentPort } = require('node:worker_threads');
parentPort.on('message', data => {
    if (data.mode === 'crash') process.exit(7);
    if (data.mode === 'hang') return;
    if (data.mode === 'busy') {
        Atomics.store(new Int32Array(data.started), 0, 1);
        const end = Date.now() + 250;
        while (Date.now() < end) { /* simulate PDF CPU work in this worker */ }
    }
    setTimeout(() => parentPort.postMessage({ bytes: Buffer.from(data.text || 'ok') }), data.delay || 0);
});
