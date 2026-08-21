const {SecureHttpClient} = require("../../src/utils/secure-http-client");

const COMMON_SCHEMA_URL =
    "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/common/schema.json";

test("GitHub serves the FEGA common schema", async () => {
    const response = await new SecureHttpClient().getJson(COMMON_SCHEMA_URL, {
        kind: "remoteSchema"
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual(expect.objectContaining({
        type: expect.any(String)
    }));
});
