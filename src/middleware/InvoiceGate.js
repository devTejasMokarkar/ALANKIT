function createInvoiceGate({ maxInFlight = 64 } = {}) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
        throw new Error("INVOICE_MAX_INFLIGHT must be a positive integer");
    }
    let active = 0;
    const waiters = new Set();
    function gate(req, res, next) {
        if (active >= maxInFlight) {
            res.setHeader("Retry-After", "1");
            return res.status(503).json({
                status: false, code: "INVOICE_BUSY",
                message: "Invoice capacity reached. Retry later.",
            });
        }
        active++;
        let released = false;
        // Keep the slot until all work settles, including after a client disconnect.
        res.locals.releaseInvoice = () => {
            if (released) return;
            released = true;
            active--;
            if (active === 0) {
                for (const resolve of waiters) resolve();
                waiters.clear();
            }
        };
        next();
    }
    gate.waitForIdle = () => active === 0 ? Promise.resolve() : new Promise(resolve => waiters.add(resolve));
    return gate;
}

const invoiceGate = createInvoiceGate({ maxInFlight: Number(process.env.INVOICE_MAX_INFLIGHT || 64) });
module.exports = { createInvoiceGate, invoiceGate };
