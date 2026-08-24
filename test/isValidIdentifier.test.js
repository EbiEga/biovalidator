jest.mock("axios");

const axios = require("axios");
const fs = require("fs");
const BioValidator = require('../src/core/biovalidator-core');

beforeEach(() => {
    axios.mockReset();
});

function resolvedIdentifierResponse() {
    return {
        status: 200,
        data: {
            payload: {
                resolvedResources: [{
                    compactIdentifierResolvedUrl: "https://www.ebi.ac.uk/biosamples/samples/SAMEA2397676"
                }]
            }
        }
    };
}

test(" -> IsValidIdentifier prefixes schema", async () => {
    let inputSchema = JSON.parse(fs.readFileSync("examples/schemas/isValidIdentifier-schema.json"));
    let inputData = JSON.parse(fs.readFileSync("examples/objects/isValidIdentifier_pass.json"));

    axios.mockResolvedValue(resolvedIdentifierResponse());

    await expect(new BioValidator()._validate(inputSchema, inputData)).resolves.toEqual([]);
    expect(axios).toHaveBeenCalledTimes(1);
    expect(axios.mock.calls[0][0].url).toBe(
        "https://resolver.api.identifiers.org/biosample:SAMEA2397676"
    );
});

test(" -> IsValidIdentifier single prefix", async () => {
    let inputSchema = JSON.parse(fs.readFileSync("examples/schemas/isValidIdentifier-single-prefix-schema.json"));
    let inputData = JSON.parse(fs.readFileSync("examples/objects/isValidIdentifier-single-prefix_pass.json"));

    axios.mockResolvedValue(resolvedIdentifierResponse());

    await expect(new BioValidator()._validate(inputSchema, inputData)).resolves.toEqual([]);
    expect(axios).toHaveBeenCalledTimes(1);
});

test(" -> IsValidIdentifier 2 Schema", async () => {
    let inputSchema = JSON.parse(fs.readFileSync("examples/schemas/isValidIdentifier-schema.json"));
    let inputData = JSON.parse(fs.readFileSync("examples/objects/isValidIdentifier_fail.json"));

    axios.mockResolvedValue({
        status: 200,
        data: {payload: {resolvedResources: []}}
    });

    const data = await new BioValidator()._validate(inputSchema, inputData);
    expect(data).toHaveLength(1);
    expect(data[0].message).toContain('Failed to resolve term from identifiers.org');
    expect(axios).toHaveBeenCalledTimes(1);
});

test(" -> IsValidIdentifier 3 Schema", async () => {
    let inputSchema = JSON.parse(fs.readFileSync("examples/schemas/isValidIdentifier-schema.json"));
    let inputData = JSON.parse(fs.readFileSync("examples/objects/isValidIdentifier_fail_namespace.json"));

    const data = await new BioValidator()._validate(inputSchema, inputData);
    expect(data).toHaveLength(1);
    expect(data[0].message).toContain('is not a valid namespace for the identifier');
    expect(axios).not.toHaveBeenCalled();
});
