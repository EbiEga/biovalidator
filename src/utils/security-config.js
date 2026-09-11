"use strict";

const os = require("os");
const net = require("net");

const MIB = 1024 * 1024;

const DEFAULTS = Object.freeze({
    requestMaxBytes: 4 * MIB,
    remoteSchemaMaxBytes: MIB,
    remoteSchemaTotalBytes: 4 * MIB,
    apiResponseMaxBytes: 8 * MIB,
    githubTreeMaxBytes: 5 * MIB,
    schemaMaxDepth: 64,
    schemaMaxValues: 50_000,
    remoteDocumentMax: 128,
    githubTreeMaxEntries: 10_000,
    fegaExampleMaxEntries: 100,
    customKeywordArrayMax: 64,
    customKeywordStringMaxBytes: 8 * 1024,
    outboundTimeoutMs: 20_000,
    validationTimeoutMs: 60_000,
    queueTimeoutMs: 10_000,
    queuePerWorker: 2,
    outboundConcurrency: 16,
    remoteSchemaCacheMaxBytes: 128 * MIB,
    remoteSchemaCacheMaxEntries: 2_048,
    apiCacheMaxBytes: 256 * MIB,
    apiCacheMaxEntries: 100_000,
    compiledCacheMaxEntries: 512,
    examplesRefreshMinIntervalMs: 60_000,
    remoteRefAllowlist: ["https://raw.githubusercontent.com/"]
});

function parsePositiveInteger(environment, name, fallback) {
    const raw = environment[name];
    if (raw === undefined || raw === "") {
        return fallback;
    }
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
        throw new Error(`Invalid ${name}: expected a positive whole number.`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid ${name}: value is too large to represent safely.`);
    }
    return parsed;
}

function parseBoolean(environment, name, fallback) {
    if (environment[name] === undefined) return fallback;
    if (!["true", "false"].includes(environment[name])) throw new Error(`Invalid ${name}: expected true or false.`);
    return environment[name] === "true";
}

function normalizeAllowedPrefix(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new Error(`Invalid BIOVALIDATOR_REMOTE_REF_ALLOWLIST entry '${value}': expected an HTTPS URL.`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        (parsed.port && parsed.port !== "443") || parsed.hostname === "" ||
        net.isIP(parsed.hostname.replace(/^\[|\]$/g, ""))) {
        throw new Error(
            `Invalid BIOVALIDATOR_REMOTE_REF_ALLOWLIST entry '${value}': ` +
            "only credential-free HTTPS hostname URLs on port 443 are supported."
        );
    }
    parsed.hash = "";
    parsed.search = "";
    const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    return Object.freeze({
        origin: parsed.origin.toLowerCase(),
        pathname,
        display: `${parsed.origin}${pathname}`
    });
}

function parseAllowlist(environment) {
    const raw = environment.BIOVALIDATOR_REMOTE_REF_ALLOWLIST;
    const values = raw === undefined
        ? DEFAULTS.remoteRefAllowlist
        : raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) {
        throw new Error("Invalid BIOVALIDATOR_REMOTE_REF_ALLOWLIST: at least one HTTPS prefix is required.");
    }
    return values.map(normalizeAllowedPrefix);
}

function defaultWorkerCount() {
    const parallelism = typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;
    return Math.max(1, Math.min(2, parallelism || 1));
}

function loadSecurityConfig(environment = process.env) {
    const config = {
        pressureReliefEnabled: parseBoolean(environment, "BIOVALIDATOR_PRESSURE_RELIEF_ENABLED", true),
        pressureTimeoutMs: parsePositiveInteger(environment, "BIOVALIDATOR_PRESSURE_TIMEOUT_MS", 5000),
        outboundQueueMax: parsePositiveInteger(environment, "BIOVALIDATOR_OUTBOUND_QUEUE_MAX", 256),
        validationOutboundMax: parsePositiveInteger(environment, "BIOVALIDATOR_VALIDATION_OUTBOUND_MAX", 512),
        validationOutboundMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_VALIDATION_OUTBOUND_MAX_BYTES", 64 * MIB),
        maxConnections: parsePositiveInteger(environment, "BIOVALIDATOR_MAX_CONNECTIONS", 256),
        requestTimeoutMs: parsePositiveInteger(environment, "BIOVALIDATOR_REQUEST_TIMEOUT_MS", 30_000),
        schemaStrict: parseBoolean(environment, "BIOVALIDATOR_SCHEMA_STRICT", false),
        annotationKeywords: (environment.BIOVALIDATOR_ANNOTATION_KEYWORDS || "meta:enum,meta:version")
            .split(",").map(value => value.trim()).filter(Boolean),
        validationMaxErrors: parsePositiveInteger(environment, "BIOVALIDATOR_VALIDATION_MAX_ERRORS", 1000),
        validationResultMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_VALIDATION_RESULT_MAX_BYTES", MIB),
        workerHeapMb: parsePositiveInteger(environment, "BIOVALIDATOR_WORKER_HEAP_MB", 256),
        rateLimitWindowMs: parsePositiveInteger(environment, "BIOVALIDATOR_RATE_LIMIT_WINDOW_MS", 60_000),
        rateLimitMax: parsePositiveInteger(environment, "BIOVALIDATOR_RATE_LIMIT_MAX", 60),
        rateLimitEnabled: parseBoolean(environment, "BIOVALIDATOR_RATE_LIMIT_ENABLED", true),
        requestMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_REQUEST_MAX_BYTES", DEFAULTS.requestMaxBytes),
        remoteSchemaMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_REMOTE_SCHEMA_MAX_BYTES", DEFAULTS.remoteSchemaMaxBytes),
        remoteSchemaTotalBytes: parsePositiveInteger(environment, "BIOVALIDATOR_REMOTE_SCHEMA_TOTAL_BYTES", DEFAULTS.remoteSchemaTotalBytes),
        apiResponseMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_API_RESPONSE_MAX_BYTES", DEFAULTS.apiResponseMaxBytes),
        githubTreeMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_GITHUB_TREE_MAX_BYTES", DEFAULTS.githubTreeMaxBytes),
        schemaMaxDepth: parsePositiveInteger(environment, "BIOVALIDATOR_SCHEMA_MAX_DEPTH", DEFAULTS.schemaMaxDepth),
        schemaMaxValues: parsePositiveInteger(environment, "BIOVALIDATOR_SCHEMA_MAX_VALUES", DEFAULTS.schemaMaxValues),
        remoteDocumentMax: parsePositiveInteger(environment, "BIOVALIDATOR_REMOTE_DOCUMENT_MAX", DEFAULTS.remoteDocumentMax),
        githubTreeMaxEntries: parsePositiveInteger(environment, "BIOVALIDATOR_GITHUB_TREE_MAX_ENTRIES", DEFAULTS.githubTreeMaxEntries),
        fegaExampleMaxEntries: parsePositiveInteger(environment, "BIOVALIDATOR_FEGA_EXAMPLE_MAX_ENTRIES", DEFAULTS.fegaExampleMaxEntries),
        customKeywordArrayMax: parsePositiveInteger(environment, "BIOVALIDATOR_CUSTOM_KEYWORD_ARRAY_MAX", DEFAULTS.customKeywordArrayMax),
        customKeywordStringMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES", DEFAULTS.customKeywordStringMaxBytes),
        outboundTimeoutMs: parsePositiveInteger(environment, "BIOVALIDATOR_OUTBOUND_TIMEOUT_MS", DEFAULTS.outboundTimeoutMs),
        validationTimeoutMs: parsePositiveInteger(environment, "BIOVALIDATOR_VALIDATION_TIMEOUT_MS", DEFAULTS.validationTimeoutMs),
        queueTimeoutMs: parsePositiveInteger(environment, "BIOVALIDATOR_QUEUE_TIMEOUT_MS", DEFAULTS.queueTimeoutMs),
        queuePerWorker: parsePositiveInteger(environment, "BIOVALIDATOR_QUEUE_PER_WORKER", DEFAULTS.queuePerWorker),
        outboundConcurrency: parsePositiveInteger(environment, "BIOVALIDATOR_OUTBOUND_CONCURRENCY", DEFAULTS.outboundConcurrency),
        remoteSchemaCacheMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_REMOTE_SCHEMA_CACHE_MAX_BYTES", DEFAULTS.remoteSchemaCacheMaxBytes),
        remoteSchemaCacheMaxEntries: parsePositiveInteger(environment, "BIOVALIDATOR_REMOTE_SCHEMA_CACHE_MAX_ENTRIES", DEFAULTS.remoteSchemaCacheMaxEntries),
        apiCacheMaxBytes: parsePositiveInteger(environment, "BIOVALIDATOR_API_CACHE_MAX_BYTES", DEFAULTS.apiCacheMaxBytes),
        apiCacheMaxEntries: parsePositiveInteger(environment, "BIOVALIDATOR_API_CACHE_MAX_ENTRIES", DEFAULTS.apiCacheMaxEntries),
        compiledCacheMaxEntries: parsePositiveInteger(environment, "BIOVALIDATOR_COMPILED_CACHE_MAX_ENTRIES", DEFAULTS.compiledCacheMaxEntries),
        examplesRefreshMinIntervalMs: parsePositiveInteger(environment, "BIOVALIDATOR_EXAMPLES_REFRESH_MIN_INTERVAL_MS", DEFAULTS.examplesRefreshMinIntervalMs),
        workers: parsePositiveInteger(environment, "BIOVALIDATOR_WORKERS", defaultWorkerCount()),
        remoteRefAllowlist: parseAllowlist(environment)
    };

    if (config.remoteSchemaTotalBytes < config.remoteSchemaMaxBytes) {
        throw new Error(
            "Invalid remote schema limits: BIOVALIDATOR_REMOTE_SCHEMA_TOTAL_BYTES must be at least " +
            "BIOVALIDATOR_REMOTE_SCHEMA_MAX_BYTES."
        );
    }
    return Object.freeze(config);
}

module.exports = {
    DEFAULTS,
    MIB,
    loadSecurityConfig,
    normalizeAllowedPrefix,
    parsePositiveInteger
};
