jest.mock("axios");

const axios = require("axios");
const fs = require("fs");
const BioValidator = require("../src/core/biovalidator-core");
const {installDefaultOlsMock} = require("./olsTestUtils");

describe("isChildTermOf", () => {
    beforeEach(() => {
        axios.mockReset();
        installDefaultOlsMock(axios, {
            notFoundTerms: ["http://purl.obolibrary.org/obo/UO_0000033"]
        });
    });

    test("reports a non-child term without treating OLS as unavailable", async () => {
        const jsonSchema = JSON.parse(
            fs.readFileSync("examples/schemas/isChildTerm-schema.json")
        );
        const jsonObj = JSON.parse(
            fs.readFileSync("examples/objects/isChildTerm.json")
        );

        const validator = new BioValidator();
        const data = await validator._validate(jsonSchema, jsonObj);

        expect(data).toBeDefined();
        expect(data).toHaveLength(1);
        expect(data[0].message).toContain("Provided term is not child of");
    });
});
