function createRegistrationGate({ maxInFlight = 200, ratePerSecond = 0 } = {}) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || !Number.isInteger(ratePerSecond) || ratePerSecond < 0) {
        throw new Error("Invalid registration capacity configuration");
    }
    let active = 0;
    const idleWaiters = new Set();
    let tokens = ratePerSecond;
    let updatedAt = Date.now();
    function registrationGate(req, res, next) {
        if (active >= maxInFlight) {
            res.setHeader("Retry-After", "1");
            return res.status(503).json({ Status: "ERROR", Code: "REGISTRATION_BUSY", Message: "Registration capacity reached. Retry later." });
        }
        if (ratePerSecond > 0) {
            const now = Date.now();
            tokens = Math.min(ratePerSecond, tokens + (now - updatedAt) * ratePerSecond / 1000);
            updatedAt = now;
            if (tokens < 1) {
                res.setHeader("Retry-After", "1");
                return res.status(429).json({ Status: "ERROR", Code: "REGISTRATION_RATE_LIMIT", Message: "Registration rate limit reached. Retry later." });
            }
            tokens--;
        }
        active++;
        let released = false;
        res.locals.releaseRegistration = () => {
            if (!released) {
                released = true; active--;
                if (active === 0) {
                    for (const resolve of idleWaiters) resolve();
                    idleWaiters.clear();
                }
            }
        };
        // The controller releases the slot after its database work finishes, even if the client disconnects.
        next();
    }
    registrationGate.waitForIdle = () => active === 0 ? Promise.resolve() : new Promise(resolve => idleWaiters.add(resolve));
    return registrationGate;
}

const registrationGate = createRegistrationGate({
    maxInFlight: Number(process.env.REGISTRATION_MAX_INFLIGHT || 200),
    ratePerSecond: Number(process.env.REGISTRATION_RATE_LIMIT_RPS || 0),
});

module.exports = { createRegistrationGate, registrationGate };
