"use strict";

const ValidationPool = require("../src/core/validation-pool");
const {loadSecurityConfig} = require("../src/utils/security-config");

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
