function createLogoCache(load, { maxEntries = 256, ttlMs = 300000, failureTtlMs = 5000 } = {}) {
    const entries = new Map();
    return async function getLogo(url) {
        const now = Date.now();
        const existing = entries.get(url);
        if (existing && existing.expiresAt > now) return existing.promise;
        if (existing) entries.delete(url);
        if (entries.size >= maxEntries) {
            const evictable = [...entries].find(([, entry]) => entry.expiresAt !== Infinity);
            if (!evictable) throw new Error("Logo download capacity reached");
            entries.delete(evictable[0]);
        }
        const entry = { expiresAt: Infinity };
        entry.promise = Promise.resolve().then(() => load(url)).then(result => {
            entry.expiresAt = Date.now() + (result == null ? failureTtlMs : ttlMs);
            return result;
        }, error => {
            entry.expiresAt = Date.now() + failureTtlMs;
            throw error;
        });
        entries.set(url, entry);
        return entry.promise;
    };
}

module.exports = { createLogoCache };
