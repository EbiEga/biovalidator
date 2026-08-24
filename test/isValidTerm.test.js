jest.mock("axios");

const axios = require("axios");
const fs = require("fs");
const BioValidator = require("../src/core/biovalidator-core");
const {
    docForTerm,
    installDefaultOlsMock,
    olsResponse
} = require("./olsTestUtils");

const schema = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$async": true,
    type: "object",
    properties: {
        term: {
            type: "string",
            format: "uri",
            isValidTerm: true
        }
    }
};

describe("isValidTerm", () => {
    beforeEach(() => {
        axios.mockReset();
    });

    test("accepts duplicate records with one exact IRI", async () => {
        const term = "http://purl.obolibrary.org/obo/BFO_0000040";
        axios.mockResolvedValue(olsResponse([
            docForTerm(term, {ontology_name: "duo"}),
            docForTerm(term, {ontology_name: "pato"})
        ]));

        const validator = new BioValidator();
        await expect(validator.validate(schema, {term})).resolves.toEqual([]);
    });

    test("reports a zero-result response as an invalid ontology term", async () => {
        axios.mockResolvedValue(olsResponse([], 0));

        const validator = new BioValidator();
        const errors = await validator.validate(schema, {
            term: "http://purl.obolibrary.org/obo/PATO_0001894"
        });

        expect(errors).toHaveLength(1);
        expect(errors[0].errors[0]).toContain("provided term does not exist in OLS");
    });

    test("preserves the existing invalid example behavior", async () => {
        installDefaultOlsMock(axios, {
            notFoundTerms: ["http://google.com"]
        });
        const exampleSchema = JSON.parse(
            fs.readFileSync("examples/schemas/isValidTerm-schema.json")
        );
        const exampleObject = JSON.parse(
            fs.readFileSync("examples/objects/isValidTerm.json")
        );

        const validator = new BioValidator();
        const errors = await validator.validate(exampleSchema, exampleObject);

        expect(errors).toHaveLength(1);
        expect(errors[0].errors[0]).toContain("provided term does not exist in OLS");
    });

    test("rejects OLS outages as operational AppErrors", async () => {
        axios.mockRejectedValue(new Error("connect ETIMEDOUT"));

        const validator = new BioValidator();
        await expect(validator.validate(schema, {
            term: "http://purl.obolibrary.org/obo/PATO_0001894"
        })).rejects.toMatchObject({
            error: expect.stringContaining(
                "OLS search failed for [http://purl.obolibrary.org/obo/PATO_0001894]: connect ETIMEDOUT"
            )
        });
    });
});
