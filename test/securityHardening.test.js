"use strict";

const BioValidator = require("../src/core/biovalidator-core");
const SecurityLimitError = require("../src/model/security-limit-error");
const {DEFAULTS, loadSecurityConfig} = require("../src/utils/security-config");
const {parseAndValidateUrl, SecureHttpClient} = require("../src/utils/secure-http-client");

describe("server security hardening", () => {
    const config = loadSecurityConfig({});

    test("remote schema default is over three times the calibrated FEGA common schema", () => {
        // Raw common/schema.json was 211,101 bytes at FEGA commit
        // 89db6c76c50761a12f63a1d58c1701cd451a3ff6.
        expect(DEFAULTS.remoteSchemaMaxBytes).toBeGreaterThanOrEqual(3 * 211101);
    });

    test.each([
        "http://raw.githubusercontent.com/owner/repo/main/schema.json",
        "https://127.0.0.1/schema.json",
        "https://raw.githubusercontent.com.evil.example/schema.json",
        "https://user:secret@raw.githubusercontent.com/owner/repo/main/schema.json",
        "file:///etc/passwd"
    ])("rejects unsafe server-side remote reference %s", (url) => {
        expect(() => parseAndValidateUrl(url, "remoteSchema", config))
            .toThrow(SecurityLimitError);
    });

    test("permits exact allowlisted HTTPS schema prefixes", () => {
        expect(parseAndValidateUrl(
            "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/common/schema.json",
            "remoteSchema",
            config
        ).hostname).toBe("raw.githubusercontent.com");
    });

    test("uses the 20 second outbound timeout and rejects oversized mock content", async () => {
        const adapter = jest.fn().mockResolvedValue({
            status: 200,
            data: {payload: "x".repeat(100)},
            headers: {}
        });
        const client = new SecureHttpClient({config, adapter});

        await expect(client.getJson(
            "https://raw.githubusercontent.com/owner/repo/main/schema.json",
            {kind: "remoteSchema", maxBytes: 20}
        )).rejects.toMatchObject({name: "SecurityLimitError", code: "REMOTE_SCHEMA_SIZE_LIMIT"});
        expect(adapter.mock.calls[0][0]).toMatchObject({timeout: 20000, maxRedirects: 0});
    });

    test("shares cached outbound content across calls", async () => {
        const adapter = jest.fn().mockResolvedValue({status: 200, data: {type: "string"}, headers: {}});
        const client = new SecureHttpClient({config, adapter});
        const url = "https://raw.githubusercontent.com/owner/repo/main/schema.json";

        await client.getJson(url, {kind: "remoteSchema", cache: true});
        await client.getJson(url, {kind: "remoteSchema", cache: true});

        expect(adapter).toHaveBeenCalledTimes(1);
        expect(client.snapshot().schemas.urls).toEqual([url]);
    });

    test("does not repopulate a cleared cache when an old outbound request finishes", async () => {
        let resolveRequest;
        let requestCount = 0;
        const adapter = jest.fn(() => {
            requestCount += 1;
            if (requestCount > 1) {
                return Promise.resolve({status: 200, data: {type: "string"}, headers: {}});
            }
            return new Promise((resolve) => {
                resolveRequest = resolve;
            });
        });
        const client = new SecureHttpClient({config, adapter});
        const url = "https://raw.githubusercontent.com/owner/repo/main/schema.json";

        const pending = client.getJson(url, {kind: "remoteSchema", cache: true});
        while (!resolveRequest) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        client.clear("schemas");
        resolveRequest({status: 200, data: {type: "string"}, headers: {}});
        await pending;

        expect(client.snapshot().schemas.urls).toEqual([]);
        await client.getJson(url, {kind: "remoteSchema", cache: true});
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(client.snapshot().schemas.urls).toEqual([url]);
    });

    test("compiled validators are keyed by content, not a user-controlled $id", async () => {
        const validator = new BioValidator();
        await expect(validator.validate({$id: "urn:test:shared", type: "string"}, "value"))
            .resolves.toEqual([]);
        const second = await validator.validate({$id: "urn:test:shared", type: "number"}, "value");
        expect(second).not.toEqual([]);
    });

    test("a submitted schema cannot replace an authoritative local $id", async () => {
        const validator = new BioValidator("test/resources/schema_registry/valid");
        await expect(validator.validate({
            $id: "https://example.org/local/draft2019.json",
            type: "null"
        }, null)).rejects.toMatchObject({
            name: "SecurityLimitError",
            code: "SCHEMA_ID_CONTENT_COLLISION",
            status: 422,
            help: expect.stringContaining("Deploy Biovalidator locally")
        });
    });

    test("schema complexity rejections identify the configurable deployment limit", async () => {
        const smallConfig = {...config, schemaMaxDepth: 2};
        const validator = new BioValidator(null, {securityConfig: smallConfig});
        await expect(validator.validate({allOf: [{allOf: [{type: "string"}]}]}, "x"))
            .rejects.toMatchObject({
                code: "SCHEMA_DEPTH_LIMIT",
                configuration: "BIOVALIDATOR_SCHEMA_MAX_DEPTH",
                help: expect.stringContaining("safety limit imposed by this Biovalidator deployment")
            });
    });

    test("strict runtime blocks an unallowlisted $ref before any network request", async () => {
        const adapter = jest.fn();
        const validator = new BioValidator(null, {adapter});
        await expect(validator.validate({$ref: "https://attacker.invalid/schema.json"}, {}))
            .rejects.toMatchObject({
                code: "REMOTE_SCHEMA_DESTINATION_DENIED",
                reference: "https://attacker.invalid/schema.json",
                message: expect.stringContaining("remote $ref 'https://attacker.invalid/schema.json'")
            });
        expect(adapter).not.toHaveBeenCalled();
    });

    test("identifies an invalid remote $ref in the public error", async () => {
        const validator = new BioValidator(null);

        await expect(validator.validate({$ref: "pepito"}, {})).rejects.toMatchObject({
            code: "OUTBOUND_URL_INVALID",
            reference: "pepito",
            message: expect.stringContaining("remote $ref 'pepito'")
        });
    });

    test("strict runtime accepts an allowlisted self-identifying remote schema", async () => {
        const url = "https://raw.githubusercontent.com/owner/repo/main/schema.json";
        const adapter = jest.fn().mockResolvedValue({
            status: 200,
            data: {$id: url, type: "string"},
            headers: {}
        });
        const validator = new BioValidator(null, {adapter});

        await expect(validator.validate({$ref: url}, "value")).resolves.toEqual([]);
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    test("verifies a remote schema that claims a different authoritative $id", async () => {
        const fetchedUrl = "https://raw.githubusercontent.com/attacker/repo/main/schema.json";
        const claimedUrl = "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/common/schema.json";
        const adapter = jest.fn().mockImplementation(({url}) => Promise.resolve({
            status: 200,
            data: url === fetchedUrl
                ? {$id: claimedUrl, type: "null"}
                : {$id: claimedUrl, type: "object"},
            headers: {}
        }));
        const validator = new BioValidator(null, {adapter});

        await expect(validator.validate({$ref: fetchedUrl}, null)).rejects.toMatchObject({
            code: "REMOTE_SCHEMA_ID_CONTENT_COLLISION",
            help: expect.stringContaining("Deploy Biovalidator locally")
        });
        expect(adapter).toHaveBeenCalledTimes(2);
    });

    test("does not mistake a data property named $data for an AJV $data expression", async () => {
        const validator = new BioValidator(null);
        await expect(validator.validate({
            type: "object",
            properties: {$data: {type: "string"}},
            required: ["$data"]
        }, {$data: "ordinary JSON data"})).resolves.toEqual([]);
    });
});
