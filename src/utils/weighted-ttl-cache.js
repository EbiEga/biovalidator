"use strict";

class WeightedTtlCache {
    constructor(options = {}) {
        this.maxEntries = options.maxEntries || Infinity;
        this.maxWeight = options.maxWeight || Infinity;
        this.ttlMs = options.ttlMs || 0;
        this.weigh = options.weigh || ((value) => Buffer.byteLength(JSON.stringify(value)));
        this.entries = new Map();
        this.totalWeight = 0;
    }

    _deleteExpired(key, entry, now = Date.now()) {
        if (entry && entry.expiresAt !== 0 && entry.expiresAt <= now) {
            this.delete(key);
            return true;
        }
        return false;
    }

    has(key) {
        const entry = this.entries.get(key);
        return Boolean(entry) && !this._deleteExpired(key, entry);
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry || this._deleteExpired(key, entry)) {
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key, value, options = {}) {
        const pinned = options.pinned === true;
        const weight = Math.max(1, options.weight || this.weigh(value));
        const existing = this.entries.get(key);
        if (existing) {
            this.totalWeight -= existing.weight;
            this.entries.delete(key);
        }
        const createdAt = Date.now();
        this.entries.set(key, {
            value,
            weight,
            pinned,
            createdAt,
            expiresAt: pinned || this.ttlMs === 0 ? 0 : createdAt + this.ttlMs
        });
        this.totalWeight += weight;
        this._evict();
        return true;
    }

    _evict() {
        while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
            let evicted = false;
            for (const [key, entry] of this.entries) {
                if (!entry.pinned) {
                    this.delete(key);
                    evicted = true;
                    break;
                }
            }
            if (!evicted) {
                break;
            }
        }
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }
        this.totalWeight -= entry.weight;
        return this.entries.delete(key);
    }

    clear(options = {}) {
        if (options.includePinned === true) {
            this.entries.clear();
            this.totalWeight = 0;
            return;
        }
        for (const [key, entry] of this.entries) {
            if (!entry.pinned) {
                this.delete(key);
            }
        }
    }

    keys() {
        for (const [key, entry] of [...this.entries]) {
            this._deleteExpired(key, entry);
        }
        return [...this.entries.keys()];
    }

    /**
     * Return lifecycle metadata without exposing the cached value. Expired
     * entries are removed before their metadata is returned.
     */
    getEntryInfo(key) {
        const entry = this.entries.get(key);
        if (!entry || this._deleteExpired(key, entry)) {
            return undefined;
        }
        return {
            weight: entry.weight,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt
        };
    }

    get size() {
        this.keys();
        return this.entries.size;
    }

    snapshot() {
        return {entries: this.size, weight_bytes: this.totalWeight};
    }
}

module.exports = WeightedTtlCache;
