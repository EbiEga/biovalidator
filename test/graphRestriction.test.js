jest.mock("axios");

const axios = require("axios");
const fs = require("fs");
const BioValidator = require("../src/core/biovalidator-core");
const GraphRestriction = require("../src/keywords/graphRestriction");
const {
    docForTerm,
    installDefaultOlsMock,
    olsResponse
} = require("./olsTestUtils");

describe("graphRestriction", () => {
    beforeEach(() => {
        axios.mockReset();
    });

    test("passes an exact child CURIE", async () => {
        installDefaultOlsMock(axios);
        const jsonSchema = JSON.parse(
            fs.readFileSync("examples/schemas/graphRestriction-schema.json")
        );
        const jsonObj = JSON.parse(
            fs.readFileSync("examples/objects/graphRestriction_pass.json")
        );
        expect(
            jsonSchema.properties.ontology.graphRestriction.queryFields
        ).toBeUndefined();

        const validator = new BioValidator();
        await expect(validator.validate(jsonSchema, jsonObj)).resolves.toEqual([]);
    });

    test("preserves includeSelf behavior without calling OLS", async () => {
        const jsonSchema = JSON.parse(
            fs.readFileSync("examples/schemas/graphRestriction-schema.json")
        );
        const jsonObj = JSON.parse(
            fs.readFileSync("examples/objects/graphRestriction_normal.json")
        );

        const validator = new BioValidator();
        await expect(validator.validate(jsonSchema, jsonObj)).resolves.toEqual([]);
        expect(axios).not.toHaveBeenCalled();
    });

    test("reports a non-child term", async () => {
        installDefaultOlsMock(axios, {notFoundTerms: ["EFO:0008481"]});
        const jsonSchema = JSON.parse(
            fs.readFileSync("examples/schemas/graphRestriction-schema.json")
        );
        const jsonObj = JSON.parse(
            fs.readFileSync("examples/objects/graphRestriction_fail.json")
        );

        const validator = new BioValidator();
        const data = await validator._validate(jsonSchema, jsonObj);

        expect(data).toHaveLength(1);
        expect(data[0].message).toContain("Provided term is not child of");
    });

    test.each([
        [["label"], "glioblastoma", {label: "glioblastoma", obo_id: "MONDO:0018177"}],
        [["obo_id"], "MONDO:0018177", {label: "glioblastoma", obo_id: "MONDO:0018177"}],
        [["obo_id", "label"], "glioblastoma", {label: "glioblastoma", obo_id: "MONDO:0018177"}]
    ])("filters exact matches locally for queryFields %j", async (queryFields, term, exactDoc) => {
        axios.mockResolvedValue(olsResponse([
            docForTerm("unrelated", {
                iri: "http://example.org/unrelated",
                label: "other",
                obo_id: "OTHER:1"
            }),
            docForTerm(term, {
                iri: "http://purl.obolibrary.org/obo/MONDO_0018177",
                ...exactDoc
            })
        ]));

        const restriction = new GraphRestriction();
        const validate = restriction.generateKeywordFunction();
        await expect(validate({
            classes: ["http://purl.obolibrary.org/obo/MONDO_0000001"],
            ontologies: ["mondo"],
            queryFields
        }, term)).resolves.toBe(true);

        const requestedUrl = new URL(axios.mock.calls[0][0].url);
        expect(requestedUrl.searchParams.get("queryFields")).toBeNull();
        expect(requestedUrl.searchParams.get("groupField")).toBeNull();
    });

    test("defaults omitted queryFields to obo_id, not label", async () => {
        axios.mockResolvedValue(olsResponse([
            docForTerm("glioblastoma", {
                iri: "http://purl.obolibrary.org/obo/MONDO_0018177",
                label: "glioblastoma",
                obo_id: "MONDO:0018177"
            })
        ]));

        const restriction = new GraphRestriction();
        const validate = restriction.generateKeywordFunction();

        await expect(validate({
            classes: ["http://purl.obolibrary.org/obo/MONDO_0000001"],
            ontologies: ["mondo"]
        }, "glioblastoma")).rejects.toMatchObject({
            errors: [
                expect.objectContaining({
                    message: expect.stringContaining("Provided term is not child of")
                })
            ]
        });
    });

    test("rejects unsupported local queryFields", async () => {
        const restriction = new GraphRestriction();
        const validate = restriction.generateKeywordFunction();

        await expect(validate({
            classes: ["http://purl.obolibrary.org/obo/MONDO_0000001"],
            ontologies: ["mondo"],
            queryFields: ["short_form"]
        }, "MONDO:0018177")).rejects.toMatchObject({
            errors: [
                expect.objectContaining({
                    message: expect.stringContaining("Supported fields are: obo_id, label")
                })
            ]
        });
        expect(axios).not.toHaveBeenCalled();
    });

    test("reports exact label matches with distinct IRIs as ambiguous", async () => {
        axios.mockResolvedValue(olsResponse([
            docForTerm("shared label", {
                iri: "http://example.org/one",
                label: "shared label"
            }),
            docForTerm("shared label", {
                iri: "http://example.org/two",
                label: "shared label"
            })
        ]));

        const restriction = new GraphRestriction();
        const validate = restriction.generateKeywordFunction();

        await expect(validate({
            classes: ["http://purl.obolibrary.org/obo/MONDO_0000001"],
            ontologies: ["mondo"],
            queryFields: ["label"]
        }, "shared label")).rejects.toMatchObject({
            errors: [
                expect.objectContaining({
                    message: "OLS term is ambiguous: [shared label] resolved to multiple IRIs."
                })
            ]
        });
    });
});
