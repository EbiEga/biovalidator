const {OlsSearchClient} = require("../../src/utils/ols_search_client");

test("OLS resolves the BFO material entity term", async () => {
    await expect(
        new OlsSearchClient().resolveUniqueIri("BFO:0000040", ["obo_id"])
    ).resolves.toBe("http://purl.obolibrary.org/obo/BFO_0000040");
});
