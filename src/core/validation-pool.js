"use strict";

const path = require("path");
const {Worker} = require("worker_threads");
const SecurityLimitError = require("../model/security-limit-error");
const {digestJson} = require("../utils/json-security");

function hydrateError(serialized) {
    if (serialized && serialized.name === "SecurityLimitError") {
        return new SecurityLimitError(serialized.message, serialized);
    }
    const error = new Error(serialized && serialized.message || "Validation worker failed");
    Object.assign(error, serialized || {});
    return error;
}

function createInventory() {
    return {registered: new Set(), validatorID: new Set(), referenced: new Set()};
}

function inventoryFromMessage(inventory) {
    const result = createInventory();
    for (const category of Object.keys(result)) {
        for (const value of inventory && inventory[category] || []) {
            result[category].add(value);
        }
    }
    return result;
}

class ValidationPool {
    constructor(options) {
        this.localSchemaPath = options.localSchemaPath;
        this.securityConfig = options.securityConfig;
        this.httpClient = options.httpClient;
        this.maxWorkers = this.securityConfig.workers;
        this.workers = [];
        this.queue = [];
        this.jobs = new Map();
        this.sequence = 0;
        this.inventory = createInventory();
        this.cacheClearSequence = 0;
        this.cacheClearPromise = null;
        this.closed = false;
    }

    validate(schema, data) {
        if (this.closed) {
            return Promise.reject(new Error("Validation worker pool is closed."));
        }
        if (this.queue.length >= this.maxWorkers * this.securityConfig.queuePerWorker) {
            return Promise.reject(new SecurityLimitError(
                "This Biovalidator deployment is at its concurrent validation capacity; please retry shortly.",
                {
                    code: "VALIDATION_CAPACITY_LIMIT",
                    status: 503,
                    configuration: "BIOVALIDATOR_WORKERS and BIOVALIDATOR_QUEUE_PER_WORKER"
                }
            ));
        }

        const digest = digestJson(schema);
        return new Promise((resolve, reject) => {
            const job = {id: ++this.sequence, schema, data, digest, resolve, reject, queuedAt: Date.now()};
            job.queueTimer = setTimeout(() => {
                const index = this.queue.indexOf(job);
                const pendingSlot = this.workers.find((slot) => slot.pendingJob === job);
                if (index !== -1) {
                    this.queue.splice(index, 1);
                } else if (pendingSlot) {
                    pendingSlot.pendingJob = null;
                    pendingSlot.intentional = true;
                    this.workers = this.workers.filter((slot) => slot !== pendingSlot);
                    if (pendingSlot.cacheClear) {
                        const resolve = pendingSlot.cacheClear.resolve;
                        pendingSlot.cacheClear = null;
                        resolve();
                    }
                    this._rebuildInventory();
                    pendingSlot.worker.terminate();
                } else {
                    return;
                }
                reject(new SecurityLimitError(
                    `This validation waited more than ${this.securityConfig.queueTimeoutMs}ms for worker capacity.`,
                    {
                        code: "VALIDATION_QUEUE_TIMEOUT",
                        status: 503,
                        configuration: "BIOVALIDATOR_QUEUE_TIMEOUT_MS",
                        limit: {name: "validation_queue_timeout_ms", configured: this.securityConfig.queueTimeoutMs,
                            observed: Date.now() - job.queuedAt, unit: "milliseconds"}
                    }
                ));
                this._dispatch();
            }, this.securityConfig.queueTimeoutMs);
            job.queueTimer.unref();
            this.queue.push(job);
            this._dispatch();
        });
    }

    _dispatch() {
        if (this.closed || this.cacheClearPromise || this.queue.length === 0) {
            return;
        }
        let idle = this.workers.filter((slot) => slot.ready && !slot.job);
        while (this.queue.length > 0 && (idle.length > 0 || this.workers.length < this.maxWorkers)) {
            const job = this.queue.shift();
            let slot = idle.find((candidate) => candidate.digests.has(job.digest)) || idle.shift();
            if (!slot) {
                slot = this._spawnWorker();
                slot.pendingJob = job;
                continue;
            }
            idle = idle.filter((candidate) => candidate !== slot);
            this._run(slot, job);
        }
    }

    _spawnWorker() {
        const worker = new Worker(path.join(__dirname, "validation-worker.js"), {
            workerData: {
                localSchemaPath: this.localSchemaPath,
                securityConfig: this.securityConfig
            }
        });
        const slot = {
            worker,
            ready: false,
            job: null,
            pendingJob: null,
            digests: new Set(),
            inventory: createInventory(),
            cacheClear: null,
            intentional: false
        };
        this.workers.push(slot);
        worker.on("message", (message) => this._onMessage(slot, message));
        worker.on("error", (error) => this._onWorkerFailure(slot, error));
        worker.on("exit", (code) => {
            if (!slot.intentional && code !== 0) {
                this._onWorkerFailure(slot, new Error(`Validation worker exited with code ${code}.`));
            }
        });
        return slot;
    }

    _onMessage(slot, message) {
        if (!message) {
            return;
        }
        if (message.type === "ready") {
            slot.ready = true;
            this._setWorkerInventory(slot, message.inventory);
            if (slot.pendingJob) {
                const job = slot.pendingJob;
                slot.pendingJob = null;
                this._run(slot, job);
            } else {
                this._dispatch();
            }
            return;
        }
        if (message.type === "outbound") {
            this.httpClient.getJson(message.url, message.options || {}).then((response) => {
                this._postToLiveWorker(slot, {type: "outboundResult", requestId: message.requestId, response});
            }).catch((error) => {
                this._postToLiveWorker(slot, {
                    type: "outboundResult",
                    requestId: message.requestId,
                    error: {
                        name: error.name,
                        message: error.message,
                        code: error.code,
                        status: error.status,
                        limit: error.limit,
                        configuration: error.configuration,
                        help: error.help
                    }
                });
            });
            return;
        }
        if (message.type === "cacheCleared") {
            this._setWorkerInventory(slot, message.inventory);
            if (slot.cacheClear && (message.clearId === undefined || message.clearId === slot.cacheClear.id)) {
                const resolve = slot.cacheClear.resolve;
                slot.cacheClear = null;
                resolve();
            }
            return;
        }
        if (message.type === "validationResult" && slot.job && slot.job.id === message.jobId) {
            const job = slot.job;
            clearTimeout(job.executionTimer);
            slot.job = null;
            this.jobs.delete(job.id);
            slot.digests.add(job.digest);
            this._setWorkerInventory(slot, message.inventory);
            if (message.error) {
                job.reject(hydrateError(message.error));
            } else {
                job.resolve(message.result);
            }
            this._dispatch();
        }
    }

    _run(slot, job) {
        clearTimeout(job.queueTimer);
        slot.job = job;
        this.jobs.set(job.id, job);
        job.executionTimer = setTimeout(() => {
            if (slot.job !== job) {
                return;
            }
            slot.job = null;
            this.jobs.delete(job.id);
            slot.intentional = true;
            slot.worker.terminate();
            this.workers = this.workers.filter((candidate) => candidate !== slot);
            if (slot.cacheClear) {
                const resolve = slot.cacheClear.resolve;
                slot.cacheClear = null;
                resolve();
            }
            this._rebuildInventory();
            job.reject(new SecurityLimitError(
                `This validation exceeded this Biovalidator deployment's ${this.securityConfig.validationTimeoutMs}ms deadline.`,
                {
                    code: "VALIDATION_TIMEOUT",
                    status: 422,
                    configuration: "BIOVALIDATOR_VALIDATION_TIMEOUT_MS",
                    limit: {name: "validation_timeout_ms", configured: this.securityConfig.validationTimeoutMs,
                        observed: this.securityConfig.validationTimeoutMs, unit: "milliseconds"}
                }
            ));
            this._dispatch();
        }, this.securityConfig.validationTimeoutMs);
        job.executionTimer.unref();
        slot.worker.postMessage({type: "validate", jobId: job.id, schema: job.schema, data: job.data});
    }

    _postToLiveWorker(slot, message) {
        if (!this.workers.includes(slot) || slot.intentional) {
            return;
        }
        try {
            slot.worker.postMessage(message);
        } catch (error) {
            this._onWorkerFailure(slot, error);
        }
    }

    _onWorkerFailure(slot, error) {
        if (!this.workers.includes(slot)) {
            return;
        }
        this.workers = this.workers.filter((candidate) => candidate !== slot);
        if (slot.cacheClear) {
            const resolve = slot.cacheClear.resolve;
            slot.cacheClear = null;
            resolve();
        }
        this._rebuildInventory();
        if (slot.job) {
            clearTimeout(slot.job.executionTimer);
            this.jobs.delete(slot.job.id);
            slot.job.reject(error);
            slot.job = null;
        }
        if (slot.pendingJob) {
            clearTimeout(slot.pendingJob.queueTimer);
            slot.pendingJob.reject(error);
            slot.pendingJob = null;
        }
        this._dispatch();
    }

    _setWorkerInventory(slot, inventory) {
        slot.inventory = inventoryFromMessage(inventory);
        this._rebuildInventory();
    }

    _rebuildInventory() {
        for (const category of Object.keys(this.inventory)) {
            this.inventory[category].clear();
        }
        for (const slot of this.workers) {
            for (const category of Object.keys(this.inventory)) {
                for (const value of slot.inventory && slot.inventory[category] || []) {
                    this.inventory[category].add(value);
                }
            }
        }
    }

    _requestWorkerCacheClear(slot, clearId) {
        if (!this.workers.includes(slot) || slot.intentional) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            slot.cacheClear = {id: clearId, resolve};
            try {
                slot.worker.postMessage({type: "clearCaches", clearId});
            } catch (error) {
                slot.cacheClear = null;
                this._onWorkerFailure(slot, error);
                resolve();
            }
        });
    }

    clearSchemaCaches() {
        if (this.cacheClearPromise) {
            return this.cacheClearPromise;
        }

        this.inventory.validatorID.clear();
        this.inventory.referenced.clear();
        const slots = [...this.workers];
        for (const slot of slots) {
            slot.digests.clear();
            if (slot.inventory) {
                slot.inventory.validatorID.clear();
                slot.inventory.referenced.clear();
            }
        }
        this._rebuildInventory();

        const clearId = ++this.cacheClearSequence;
        this.cacheClearPromise = Promise.all(slots.map((slot) => this._requestWorkerCacheClear(slot, clearId)))
            .then(() => {
                this.cacheClearPromise = null;
                this._rebuildInventory();
                this._dispatch();
            });
        return this.cacheClearPromise;
    }

    getSchemaInventory() {
        return Object.fromEntries(Object.entries(this.inventory)
            .map(([key, values]) => [key, [...values].sort()]));
    }

    getDetails() {
        return {
            workers: {configured: this.maxWorkers, started: this.workers.length,
                busy: this.workers.filter((slot) => Boolean(slot.job)).length},
            queue: {entries: this.queue.length}
        };
    }

    async close() {
        this.closed = true;
        for (const job of this.queue.splice(0)) {
            clearTimeout(job.queueTimer);
            job.reject(new Error("Validation worker pool closed."));
        }
        for (const slot of this.workers) {
            if (slot.pendingJob) {
                clearTimeout(slot.pendingJob.queueTimer);
                slot.pendingJob.reject(new Error("Validation worker pool closed."));
                slot.pendingJob = null;
            }
            if (slot.job) {
                clearTimeout(slot.job.executionTimer);
                this.jobs.delete(slot.job.id);
                slot.job.reject(new Error("Validation worker pool closed."));
                slot.job = null;
            }
            if (slot.cacheClear) {
                const resolve = slot.cacheClear.resolve;
                slot.cacheClear = null;
                resolve();
            }
        }
        await Promise.all(this.workers.map((slot) => {
            slot.intentional = true;
            return slot.worker.terminate();
        }));
        this.workers = [];
    }
}

module.exports = ValidationPool;
