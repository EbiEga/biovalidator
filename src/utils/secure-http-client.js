"use strict";

const net = require("net");
const axios = require("axios");
const SecurityLimitError = require("../model/security-limit-error");
const WeightedTtlCache = require("./weighted-ttl-cache");
const {loadSecurityConfig} = require("./security-config");
const {CACHE_TTL_SECONDS} = require("./cache-config");

const FIXED_DESTINATIONS = Object.freeze({
    ols: [{origin: "https://www.ebi.ac.uk", pathname: "/ols4/api/search"}],
    ena: [{origin: "https://www.ebi.ac.uk", pathname: "/ena/taxonomy/rest/any-name/"}],
    identifiers: [{origin: "https://resolver.api.identifiers.org", pathname: "/"}],
    githubApi: [{origin: "https://api.github.com", pathname: "/repos/"}],
    githubRaw: [{origin: "https://raw.githubusercontent.com", pathname: "/"}]
});

const API_PROVIDER_NAMES = Object.freeze({
    ols: "ols",
    ena: "ena_taxonomy",
    identifiers: "identifiers_org",
    githubApi: "github_api"
});

function pathMatches(candidate, allowed) {
    if (allowed === "/") {
        return true;
    }
    const prefix = allowed.endsWith("/") ? allowed : `${allowed}/`;
    return candidate === allowed || candidate.startsWith(prefix);
}

function parseAndValidateUrl(rawUrl, kind, config) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (error) {
        throw new SecurityLimitError(`Biovalidator rejected an invalid outbound URL: ${rawUrl}`, {
            code: "OUTBOUND_URL_INVALID",
            status: 422
        });
    }

    if (parsed.username || parsed.password) {
        throw new SecurityLimitError("Biovalidator does not permit credentials in outbound URLs.", {
            code: "OUTBOUND_URL_CREDENTIALS_DENIED",
            status: 422
        });
    }
    if (/\\|%(?:2f|5c|00)/i.test(parsed.pathname)) {
        throw new SecurityLimitError("Biovalidator rejected an ambiguously encoded outbound URL path.", {
            code: "OUTBOUND_URL_PATH_INVALID",
            status: 422
        });
    }

    if (parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443") || net.isIP(parsed.hostname)) {
        throw new SecurityLimitError(
            "This Biovalidator deployment permits only HTTPS hostnames on port 443 for outbound requests.",
            {
                code: "OUTBOUND_DESTINATION_DENIED",
                status: 422,
                configuration: kind === "remoteSchema" ? "BIOVALIDATOR_REMOTE_REF_ALLOWLIST" : undefined
            }
        );
    }

    const allowed = kind === "remoteSchema"
        ? config.remoteRefAllowlist
        : (FIXED_DESTINATIONS[kind] || []);
    const origin = parsed.origin.toLowerCase();
    const matched = allowed.some((entry) => origin === entry.origin && pathMatches(parsed.pathname, entry.pathname));
    if (!matched) {
        throw new SecurityLimitError(
            `This Biovalidator deployment does not allow outbound ${kind} requests to ${parsed.origin}${parsed.pathname}.`,
            {
                code: kind === "remoteSchema" ? "REMOTE_SCHEMA_DESTINATION_DENIED" : "UPSTREAM_DESTINATION_DENIED",
                status: 422,
                configuration: kind === "remoteSchema" ? "BIOVALIDATOR_REMOTE_REF_ALLOWLIST" : undefined
            }
        );
    }
    return parsed;
}

function approximateBytes(value) {
    if (Buffer.isBuffer(value)) {
        return value.length;
    }
    if (typeof value === "string") {
        return Buffer.byteLength(value);
    }
    return Buffer.byteLength(JSON.stringify(value));
}

class WorkConservingSemaphore {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.waiting = [];
    }

    acquire() {
        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    release() {
        const next = this.waiting.shift();
        if (next) {
            next();
        } else {
            this.active = Math.max(0, this.active - 1);
        }
    }
}

class SecureHttpClient {
    constructor(options = {}) {
        this.config = options.config || loadSecurityConfig();
        this.adapter = options.adapter || axios;
        this.semaphore = options.semaphore || new WorkConservingSemaphore(this.config.outboundConcurrency);
        this.inFlight = new Map();
        const ttlMs = CACHE_TTL_SECONDS * 1000;
        this.remoteCache = options.remoteCache || new WeightedTtlCache({
            maxEntries: this.config.remoteSchemaCacheMaxEntries,
            maxWeight: this.config.remoteSchemaCacheMaxBytes,
            ttlMs
        });
        this.apiCache = options.apiCache || new WeightedTtlCache({
            maxEntries: this.config.apiCacheMaxEntries,
            maxWeight: this.config.apiCacheMaxBytes,
            ttlMs
        });
        // A clear invalidates both entries already stored and responses that
        // are still in flight. The latter must not repopulate a cache after a
        // successful DELETE /cache response.
        this.cacheGenerations = new Map();
        this.apiLifecycle = new Map(Object.keys(API_PROVIDER_NAMES).map((kind) => [kind, {
            lastUpdatedAt: null,
            lastClearedAt: null
        }]));
    }

    async getJson(rawUrl, options = {}) {
        const kind = options.kind || "remoteSchema";
        const parsed = parseAndValidateUrl(rawUrl, kind, this.config);
        parsed.hash = "";
        const url = parsed.toString();
        const maxBytes = options.maxBytes || this._maxBytesFor(kind);
        const cache = kind === "remoteSchema" || kind === "githubRaw" ? this.remoteCache : this.apiCache;
        const cacheKey = `${kind}:${url}`;
        const useCache = options.cache === true;
        const forceRefresh = options.forceRefresh === true;
        const generation = this._cacheGeneration(kind);

        if (useCache && !forceRefresh) {
            const cached = cache.get(cacheKey);
            if (cached !== undefined) {
                const observed = cached.sizeBytes || approximateBytes(cached.data);
                if (observed > maxBytes) {
                    throw this._sizeLimitError(kind, maxBytes, observed);
                }
                return cached;
            }
            if (this.inFlight.has(cacheKey)) {
                return this.inFlight.get(cacheKey);
            }
        }

        const request = this._request(url, kind, maxBytes, options.signal);
        if (useCache) {
            this.inFlight.set(cacheKey, request);
        }
        try {
            const response = await request;
            if (useCache && this._cacheGeneration(kind) === generation) {
                if (options.cacheSink && typeof options.cacheSink.push === "function") {
                    options.cacheSink.push({kind, url, response, generation});
                } else {
                    cache.set(cacheKey, response, {weight: response.sizeBytes || approximateBytes(response.data)});
                    this._recordApiSet(kind);
                }
            }
            return response;
        } finally {
            if (useCache) {
                // A forced refresh can replace a prior request for the same
                // URL. Only the current request may remove the map entry.
                if (this.inFlight.get(cacheKey) === request) {
                    this.inFlight.delete(cacheKey);
                }
            }
        }
    }

    async _request(url, kind, maxBytes, signal) {
        await this.semaphore.acquire();
        try {
            let response;
            try {
                response = await this.adapter({
                    method: "GET",
                    url,
                    responseType: "text",
                    transformResponse: [(value) => value],
                    timeout: this.config.outboundTimeoutMs,
                    maxRedirects: 0,
                    maxContentLength: maxBytes,
                    maxBodyLength: maxBytes,
                    signal,
                    transitional: {silentJSONParsing: false, clarifyTimeoutError: true}
                });
            } catch (error) {
                if (error && (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED")) {
                    throw new SecurityLimitError(
                        `The outbound ${kind} request exceeded this Biovalidator deployment's ${this.config.outboundTimeoutMs}ms timeout.`,
                        {
                            code: "OUTBOUND_TIMEOUT",
                            status: 504,
                            configuration: "BIOVALIDATOR_OUTBOUND_TIMEOUT_MS",
                            limit: {name: "outbound_timeout_ms", configured: this.config.outboundTimeoutMs,
                                observed: this.config.outboundTimeoutMs, unit: "milliseconds"}
                        }
                    );
                }
                throw error;
            }
            const observed = approximateBytes(response.data);
            if (observed > maxBytes) {
                throw this._sizeLimitError(kind, maxBytes, observed);
            }
            let payload = response.data;
            if (typeof payload === "string") {
                try {
                    payload = JSON.parse(payload);
                } catch (error) {
                    throw new SecurityLimitError(`The ${kind} service returned malformed JSON content.`, {
                        code: "UPSTREAM_JSON_INVALID",
                        status: 502
                    });
                }
            }
            if (payload === null || typeof payload !== "object") {
                throw new SecurityLimitError(`The ${kind} service returned malformed JSON content.`, {
                    code: "UPSTREAM_JSON_INVALID",
                    status: 502
                });
            }
            return {status: response.status, data: payload, headers: {...(response.headers || {})}, sizeBytes: observed};
        } finally {
            this.semaphore.release();
        }
    }

    _maxBytesFor(kind) {
        if (kind === "remoteSchema" || kind === "githubRaw") {
            return this.config.remoteSchemaMaxBytes;
        }
        if (kind === "githubApi") {
            return this.config.githubTreeMaxBytes;
        }
        return this.config.apiResponseMaxBytes;
    }

    _sizeLimitError(kind, maxBytes, observed) {
        const configurationByKind = {
            remoteSchema: "BIOVALIDATOR_REMOTE_SCHEMA_MAX_BYTES",
            githubRaw: "BIOVALIDATOR_REMOTE_SCHEMA_MAX_BYTES",
            githubApi: "BIOVALIDATOR_GITHUB_TREE_MAX_BYTES"
        };
        return new SecurityLimitError(
            `An outbound ${kind} response exceeded this Biovalidator deployment's ${maxBytes}-byte limit.`,
            {
                code: kind === "remoteSchema" ? "REMOTE_SCHEMA_SIZE_LIMIT" : "UPSTREAM_RESPONSE_SIZE_LIMIT",
                status: 502,
                configuration: configurationByKind[kind] || "BIOVALIDATOR_API_RESPONSE_MAX_BYTES",
                limit: {name: `${kind}_max_bytes`, configured: maxBytes, observed, unit: "bytes"}
            }
        );
    }

    clear(scope = "all") {
        const shouldClearKind = (kind) => (
            scope === "all" ||
            (scope === "schemas" && (kind === "remoteSchema" || kind === "githubRaw")) ||
            (scope === "api" && kind !== "remoteSchema" && kind !== "githubRaw")
        );
        const kinds = this._kindsForScope(scope);
        this._invalidateInFlight(shouldClearKind);
        this._bumpGenerations(kinds);
        if (scope === "all" || scope === "schemas") {
            this.remoteCache.clear();
        }
        if (scope === "all" || scope === "api") {
            this.apiCache.clear();
            this._recordApiClear(kinds);
        }
    }

    clearKind(kind) {
        const prefix = `${kind}:`;
        this._invalidateInFlight((candidate) => candidate === kind);
        this._bumpGenerations([kind]);
        const cache = kind === "remoteSchema" || kind === "githubRaw" ? this.remoteCache : this.apiCache;
        for (const key of cache.keys()) {
            if (key.startsWith(prefix)) {
                cache.delete(key);
            }
        }
        this._recordApiClear([kind]);
    }

    /**
     * Commit responses collected by a caller that needs an all-or-nothing
     * refresh. Entries fetched before a cache clear are discarded by the
     * generation check, while entries fetched after it remain valid.
     */
    commitCache(entries = [], options = {}) {
        const replaceKinds = new Set(Array.isArray(options.replaceKinds) ? options.replaceKinds : []);
        if (replaceKinds.size > 0) {
            const retainedKeys = new Set(entries
                .filter((entry) => entry && typeof entry.kind === "string" && replaceKinds.has(entry.kind) &&
                    typeof entry.url === "string")
                .map((entry) => `${entry.kind}:${entry.url}`));
            for (const kind of replaceKinds) {
                const cache = kind === "remoteSchema" || kind === "githubRaw"
                    ? this.remoteCache
                    : this.apiCache;
                for (const key of cache.keys()) {
                    if (key.startsWith(`${kind}:`) && !retainedKeys.has(key)) {
                        cache.delete(key);
                    }
                }
            }
        }
        for (const entry of entries) {
            if (!entry || typeof entry.kind !== "string" || typeof entry.url !== "string" ||
                !entry.response || this._cacheGeneration(entry.kind) !== entry.generation) {
                continue;
            }
            const cache = entry.kind === "remoteSchema" || entry.kind === "githubRaw"
                ? this.remoteCache
                : this.apiCache;
            const cacheKey = `${entry.kind}:${entry.url}`;
            const response = entry.response;
            cache.set(cacheKey, response, {
                weight: response.sizeBytes || approximateBytes(response.data)
            });
            this._recordApiSet(entry.kind);
        }
    }

    // Entries collected through cacheSink are not resident until commitCache;
    // discarding them therefore only needs to release the caller's references.
    discardCache(_entries = []) {}

    _cacheGeneration(kind) {
        return this.cacheGenerations.get(kind) || 0;
    }

    _invalidateInFlight(predicate) {
        const invalidatedKinds = new Set();
        for (const key of this.inFlight.keys()) {
            const separator = key.indexOf(":");
            const kind = separator === -1 ? key : key.slice(0, separator);
            if (predicate(kind)) {
                this.inFlight.delete(key);
                invalidatedKinds.add(kind);
            }
        }
        return invalidatedKinds;
    }

    _kindsForScope(scope) {
        if (scope === "schemas") {
            return ["remoteSchema", "githubRaw"];
        }
        if (scope === "api") {
            return Object.keys(API_PROVIDER_NAMES);
        }
        return ["remoteSchema", "githubRaw", ...Object.keys(API_PROVIDER_NAMES)];
    }

    _bumpGenerations(kinds) {
        for (const kind of kinds) {
            this.cacheGenerations.set(kind, this._cacheGeneration(kind) + 1);
        }
    }

    _recordApiSet(kind) {
        if (this.apiLifecycle.has(kind)) {
            this.apiLifecycle.get(kind).lastUpdatedAt = Date.now();
        }
    }

    _recordApiClear(kinds) {
        const now = Date.now();
        for (const kind of kinds) {
            if (this.apiLifecycle.has(kind)) {
                this.apiLifecycle.get(kind).lastClearedAt = now;
            }
        }
    }

    _apiProviderSnapshot(kind) {
        const prefix = `${kind}:`;
        const entries = [];
        for (const key of this.apiCache.keys()) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            const info = this.apiCache.getEntryInfo(key);
            if (info) {
                entries.push(info);
            }
        }
        const expirations = entries.map((entry) => entry.expiresAt).filter((value) => value > 0);
        const lifecycle = this.apiLifecycle.get(kind) || {lastUpdatedAt: null, lastClearedAt: null};
        return {
            ttl_seconds: this.apiCache.ttlMs / 1000,
            entries: entries.length,
            last_updated_at: lifecycle.lastUpdatedAt === null ? null : new Date(lifecycle.lastUpdatedAt).toISOString(),
            last_cleared_at: lifecycle.lastClearedAt === null ? null : new Date(lifecycle.lastClearedAt).toISOString(),
            oldest_entry_at: entries.length
                ? new Date(Math.min(...entries.map((entry) => entry.createdAt))).toISOString()
                : null,
            newest_entry_at: entries.length
                ? new Date(Math.max(...entries.map((entry) => entry.createdAt))).toISOString()
                : null,
            next_expiration_at: expirations.length
                ? new Date(Math.min(...expirations)).toISOString()
                : null
        };
    }

    apiSnapshot() {
        const providers = Object.fromEntries(Object.entries(API_PROVIDER_NAMES)
            .map(([kind, provider]) => [provider, this._apiProviderSnapshot(kind)]));
        const entries = Object.fromEntries(Object.entries(providers)
            .map(([provider, snapshot]) => [provider, snapshot.entries]));
        entries.total = Object.values(providers).reduce((total, provider) => total + provider.entries, 0);
        const orderedEntries = {
            total: entries.total,
            ols: entries.ols,
            ena_taxonomy: entries.ena_taxonomy,
            identifiers_org: entries.identifiers_org,
            github_api: entries.github_api
        };
        return {
            entries: orderedEntries,
            weight_bytes: this.apiCache.snapshot().weight_bytes,
            providers
        };
    }

    snapshot() {
        return {
            schemas: {...this.remoteCache.snapshot(), urls: this._cacheUrls(this.remoteCache)},
            in_flight: this.inFlight.size,
            outbound: {active: this.semaphore.active, queued: this.semaphore.waiting.length}
        };
    }

    _cacheUrls(cache) {
        return cache.keys().map((key) => key.slice(key.indexOf(":") + 1)).sort();
    }
}

module.exports = {
    FIXED_DESTINATIONS,
    SecureHttpClient,
    WorkConservingSemaphore,
    approximateBytes,
    parseAndValidateUrl,
    pathMatches
};
