"use strict";

const ValidationPool = require("../src/core/validation-pool");
const {loadSecurityConfig} = require("../src/utils/security-config");

function createTestSlot() {
    return {
        worker: {postMessage: jest.fn()},
        ready: true,
        job: null,
        pendingJob: null,
        digests: new Set(),
        inventory: {registered: new Set(), validatorID: new Set(), referenced: new Set()},
        cacheClear: null,
        intentional: false
    };
}

test("validation workers start lazily and use available idle capacity", async () => {
    const securityConfig = {...loadSecurityConfig({}), workers: 2, queueTimeoutMs: 20000};
    const httpClient = {getJson: jest.fn(() => Promise.reject(new Error("unexpected network request")))};
    const pool = new ValidationPool({localSchemaPath: null, securityConfig, httpClient});

    expect(pool.getDetails().workers.started).toBe(0);
    try {
        const first = await pool.validate({type: "string"}, "value");
        expect(first).toEqual([]);
        expect(pool.getDetails().workers).toMatchObject({started: 1, busy: 0});

        const [valid, invalid] = await Promise.all([
            pool.validate({type: "number"}, 1),
            pool.validate({type: "boolean"}, "not-boolean")
        ]);
        expect(valid).toEqual([]);
        expect(invalid).not.toEqual([]);
        expect(pool.getDetails().workers.started).toBe(2);
        expect(httpClient.getJson).not.toHaveBeenCalled();
    } finally {
        await pool.close();
    }
}, 60000);

test("keeps inventory snapshots from independent workers separate", () => {
    const securityConfig = {...loadSecurityConfig({}), workers: 2};
    const pool = new ValidationPool({localSchemaPath: null, securityConfig, httpClient: {}});
    const first = createTestSlot();
    const second = createTestSlot();
    pool.workers = [first, second];

    pool._onMessage(first, {
        type: "ready",
        inventory: {registered: [], validatorID: ["first"], referenced: ["https://example.org/first.json"]}
    });
    pool._onMessage(second, {
        type: "ready",
        inventory: {registered: [], validatorID: ["second"], referenced: ["https://example.org/second.json"]}
    });
    expect(pool.getSchemaInventory()).toEqual({
        registered: [],
        validatorID: ["first", "second"],
        referenced: ["https://example.org/first.json", "https://example.org/second.json"]
    });

    pool._onMessage(first, {
        type: "cacheCleared",
        inventory: {registered: [], validatorID: [], referenced: []}
    });
    expect(pool.getSchemaInventory()).toEqual({
        registered: [],
        validatorID: ["second"],
        referenced: ["https://example.org/second.json"]
    });
});

test("waits for workers to acknowledge schema-cache clearing", async () => {
    const securityConfig = {...loadSecurityConfig({}), workers: 1};
    const pool = new ValidationPool({localSchemaPath: null, securityConfig, httpClient: {}});
    const slot = createTestSlot();
    pool.workers = [slot];
    pool._setWorkerInventory(slot, {
        registered: [],
        validatorID: ["compiled"],
        referenced: ["https://example.org/schema.json"]
    });

    const clearing = pool.clearSchemaCaches();
    expect(slot.worker.postMessage).toHaveBeenCalledWith({type: "clearCaches", clearId: 1});
    let settled = false;
    clearing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    pool._onMessage(slot, {
        type: "cacheCleared",
        clearId: 1,
        inventory: {registered: [], validatorID: [], referenced: []}
    });
    await clearing;
    expect(pool.getSchemaInventory()).toEqual({registered: [], validatorID: [], referenced: []});
});
