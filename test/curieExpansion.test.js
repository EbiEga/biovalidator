jest.mock("axios");

const axios = require("axios");
const CurieExpansion = require("../src/utils/curie_expansion");
const {docForTerm, olsResponse} = require("./olsTestUtils");

describe("CurieExpansion", () => {
    beforeEach(() => {
        axios.mockReset();
    });

    test("recognizes CURIE syntax", () => {
        expect(CurieExpansion.isCurie("EFO:0000399")).toBe(true);
    });

    test("expands duplicate OLS records that share one IRI", async () => {
        const iri = "http://purl.obolibrary.org/obo/BFO_0000040";
        axios.mockResolvedValue(olsResponse([
            docForTerm("BFO:0000040", {iri, ontology_name: "duo"}),
            docForTerm("BFO:0000040", {iri, ontology_name: "cl"}),
            docForTerm("BFO:0000040", {iri, ontology_name: "pato"})
        ]));

        const expansion = new CurieExpansion();
        await expect(expansion.expandCurie("BFO:0000040")).resolves.toBe(iri);

        const requestedUrl = new URL(axios.mock.calls[0][0].url);
        expect(requestedUrl.pathname).toBe("/ols4/api/search");
        expect(requestedUrl.searchParams.get("groupField")).toBeNull();
        expect(requestedUrl.searchParams.get("queryFields")).toBeNull();
    });

    test("rejects a CURIE that resolves to distinct IRIs", async () => {
        axios.mockResolvedValue(olsResponse([
            docForTerm("BFO:0000040", {iri: "http://example.org/one"}),
            docForTerm("BFO:0000040", {iri: "http://example.org/two"})
        ]));

        const expansion = new CurieExpansion();
        await expect(expansion.expandCurie("BFO:0000040")).rejects.toThrow(
            "OLS term is ambiguous: [BFO:0000040] resolved to multiple IRIs."
        );
    });

    test("does not invent a result when OLS returns zero records", async () => {
        axios.mockResolvedValue(olsResponse([], 0));

        const expansion = new CurieExpansion();
        await expect(expansion.expandCurie("PATO:0001894")).rejects.toThrow(
            "Could not retrieve IRI for [PATO:0001894]"
        );
    });

    test("resolves PATO:0001894 normally when OLS returns a repaired record", async () => {
        const iri = "http://purl.obolibrary.org/obo/PATO_0001894";
        axios.mockResolvedValue(olsResponse([
            docForTerm("PATO:0001894", {iri})
        ]));

        const expansion = new CurieExpansion();
        await expect(expansion.expandCurie("PATO:0001894")).resolves.toBe(iri);
    });
});
