const { Worker } = require("worker_threads");
const path = require("path");
const os = require("os");

function poolError(message, statusCode = 503) {
    return Object.assign(new Error(message), { statusCode });
}

class InvoicePdfPool {
    constructor({ size = 4, maxQueue = 64, timeoutMs = 30000,
        workerPath = path.join(__dirname, "../workers/invoicePdf.worker.js") } = {}) {
        if (![size, maxQueue, timeoutMs].every(value => Number.isInteger(value) && value > 0)) {
            throw new Error("Invalid invoice PDF worker pool configuration");
        }
        Object.assign(this, { size, maxQueue, timeoutMs, workerPath });
        this.workers = new Set();
        this.queue = [];
        this.closing = false;
    }

    run(data) {
        if (this.closing) return Promise.reject(poolError("Invoice PDF workers are shutting down"));
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(poolError("Invoice PDF worker queue is full. Retry later."));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ data, resolve, reject });
            this.pump();
        });
    }

    spawn() {
        const slot = { worker: new Worker(this.workerPath), task: null, stopping: false };
        slot.readyPromise = new Promise((resolve, reject) => {
            slot.resolveReady = resolve;
            slot.rejectReady = reject;
        });
        // Lazy callers may never wait for readiness; failures still reach their active task.
        slot.readyPromise.catch(() => {});
        this.workers.add(slot);
        slot.worker.on("message", result => {
            if (result.ready) {
                slot.resolveReady();
                if (!slot.task) slot.worker.unref();
                return;
            }
            if (!slot.task || slot.stopping) return;
            const task = slot.task;
            clearTimeout(slot.timer);
            slot.task = null;
            slot.worker.unref();
            if (result.error) task.reject(poolError(result.error.message, result.error.statusCode));
            else if (result.bytes instanceof Uint8Array) task.resolve(Buffer.from(result.bytes));
            else task.reject(poolError("Invalid PDF worker response", 500));
            this.pump();
        });
        slot.worker.on("error", () => this.stop(slot, poolError("Invoice PDF worker failed", 500)));
        slot.worker.on("exit", () => {
            slot.rejectReady(poolError("Invoice PDF worker exited during startup", 500));
            clearTimeout(slot.timer);
            if (slot.task) slot.task.reject(poolError("Invoice PDF worker exited", 500));
            slot.task = null;
            this.workers.delete(slot);
            this.pump();
        });
        slot.worker.unref();
        return slot;
    }

    stop(slot, error) {
        if (slot.stopping) return;
        slot.stopping = true;
        slot.rejectReady(error);
        clearTimeout(slot.timer);
        if (slot.task) slot.task.reject(error);
        slot.task = null;
        // Replace the worker only after its exit, keeping the thread count bounded.
        slot.worker.terminate().catch(() => {});
    }

    async warm() {
        if (this.closing) throw poolError("Invoice PDF workers are shutting down");
        while (this.workers.size < this.size) this.spawn();
        const slots = [...this.workers];
        for (const slot of slots) slot.worker.ref();
        await Promise.all(slots.map(slot => slot.readyPromise));
        for (const slot of slots) if (!slot.task) slot.worker.unref();
    }

    pump() {
        while (this.queue.length) {
            let slot = [...this.workers].find(candidate => !candidate.task && !candidate.stopping);
            if (!slot && this.workers.size < this.size) {
                try { slot = this.spawn(); }
                catch (_) {
                    this.queue.shift().reject(poolError("Unable to start invoice PDF worker", 500));
                    continue;
                }
            }
            if (!slot) break;
            slot.task = this.queue.shift();
            slot.worker.ref();
            slot.timer = setTimeout(() => this.stop(slot, poolError("Invoice PDF generation timed out", 504)), this.timeoutMs);
            try { slot.worker.postMessage(slot.task.data); }
            catch (_) { this.stop(slot, poolError("Unable to send invoice to PDF worker", 500)); }
        }
        if (this.closing && !this.queue.length && [...this.workers].every(slot => !slot.task)) {
            for (const slot of this.workers) this.stop(slot, poolError("Invoice PDF workers are shutting down"));
            if (!this.workers.size) this.resolveClose();
        }
    }

    close() {
        if (!this.closePromise) {
            this.closing = true;
            this.closePromise = new Promise(resolve => { this.resolveClose = resolve; });
            this.pump();
        }
        return this.closePromise;
    }
}

const parallelism = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const invoicePdfPool = new InvoicePdfPool({
    size: Number(process.env.INVOICE_PDF_WORKERS || Math.max(1, Math.min(4, parallelism - 1))),
    maxQueue: Number(process.env.INVOICE_PDF_MAX_QUEUE || 64),
    timeoutMs: Number(process.env.INVOICE_PDF_TIMEOUT_MS || 30000),
});

module.exports = { InvoicePdfPool, invoicePdfPool };
