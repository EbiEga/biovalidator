const {OlsSearchClient} = require("../../src/utils/ols_search_client");

test("OLS resolves the BFO material entity term", async () => {
    await expect(
        new OlsSearchClient().resolveUniqueIri("BFO:0000040", ["obo_id"])
    ).resolves.toBe("http://purl.obolibrary.org/obo/BFO_0000040");
});

test.each([
    ["UBERON:0001062", ["obo_id"]],
    ["http://purl.obolibrary.org/obo/UBERON_0001062", ["iri"]]
])("OLS resolves anatomical entity by %s", async (term, fields) => {
    await expect(
        new OlsSearchClient().resolveUniqueIri(term, fields, {ontology: "uberon"})
    ).resolves.toBe("http://purl.obolibrary.org/obo/UBERON_0001062");
});

test("OLS finds anatomical entity by label, including imported terms with the same label", async () => {
    await expect(
        new OlsSearchClient().findExactMatches("anatomical entity", ["label"], {ontology: "uberon"})
    ).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({iri: "http://purl.obolibrary.org/obo/UBERON_0001062"})
    ]));
});
