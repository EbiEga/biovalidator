"use strict";

const {parentPort, workerData} = require("worker_threads");
const BioValidator = require("./biovalidator-core");
const SecurityLimitError = require("../model/security-limit-error");

class ParentHttpClient {
    constructor() {
        this.sequence = 0;
        this.pending = new Map();
        parentPort.on("message", (message) => {
            if (!message || message.type !== "outboundResult") {
                return;
            }
            const pending = this.pending.get(message.requestId);
            if (!pending) {
                return;
            }
            this.pending.delete(message.requestId);
            if (message.error) {
                const error = message.error.name === "SecurityLimitError"
                    ? new SecurityLimitError(message.error.message, message.error)
                    : Object.assign(new Error(message.error.message), message.error);
                pending.reject(error);
            } else {
                if (pending.cacheSink && Array.isArray(message.cacheTokens)) {
                    pending.cacheSink.push(...message.cacheTokens.map((token) => ({__cacheToken: token})));
                }
                pending.resolve(message.response);
            }
        });
    }

    getJson(url, options = {}) {
        const requestId = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, {resolve, reject, cacheSink: options.cacheSink});
            parentPort.postMessage({
                type: "outbound",
                requestId,
                url,
                options: {
                    kind: options.kind,
                    maxBytes: options.maxBytes,
                    cache: options.cache,
                    forceRefresh: options.forceRefresh,
                    deferCache: Array.isArray(options.cacheSink)
                }
            });
        });
    }

    commitCache(entries = []) {
        const tokens = entries
            .map((entry) => entry && entry.__cacheToken)
            .filter((token) => typeof token === "string");
        if (tokens.length > 0) {
            parentPort.postMessage({type: "commitOutbound", tokens});
        }
    }

    discardCache(entries = []) {
        const tokens = entries
            .map((entry) => entry && entry.__cacheToken)
            .filter((token) => typeof token === "string");
        if (tokens.length > 0) {
            parentPort.postMessage({type: "discardOutbound", tokens});
        }
    }
}

function serializeError(error) {
    const serialized = {
        name: error && error.name,
        message: error && (error.message || error.error) || "Validation failed"
    };
    for (const key of ["code", "status", "limit", "configuration", "reference", "retryAfterSeconds", "help", "error"]) {
        if (error && error[key] !== undefined) {
            serialized[key] = error[key];
        }
    }
    return serialized;
}

const validator = new BioValidator(workerData.localSchemaPath, {
    securityConfig: workerData.securityConfig,
    httpClient: new ParentHttpClient()
});

let validationInFlight = false;
const pendingCacheClears = [];

function clearCaches(message) {
    validator.clearSchemaCaches();
    parentPort.postMessage({type: "cacheCleared", clearId: message.clearId, inventory: validator.getSchemaInventory()});
}

parentPort.on("message", async (message) => {
    if (!message) {
        return;
    }
    if (message.type === "clearCaches") {
        if (validationInFlight) {
            pendingCacheClears.push(message);
        } else {
            clearCaches(message);
        }
        return;
    }
    if (message.type !== "validate") {
        return;
    }
    validationInFlight = true;
    try {
        const result = await validator.validate(message.schema, message.data);
        parentPort.postMessage({
            type: "validationResult",
            jobId: message.jobId,
            result,
            inventory: validator.getSchemaInventory()
        });
    } catch (error) {
        parentPort.postMessage({
            type: "validationResult",
            jobId: message.jobId,
            error: serializeError(error),
            inventory: validator.getSchemaInventory()
        });
    } finally {
        validationInFlight = false;
        while (pendingCacheClears.length > 0) {
            clearCaches(pendingCacheClears.shift());
        }
    }
});

parentPort.postMessage({type: "ready", inventory: validator.getSchemaInventory()});
