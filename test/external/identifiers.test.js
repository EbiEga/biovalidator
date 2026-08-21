const IsValidIdentifier = require("../../src/keywords/isvalididentifier");

test("identifiers.org resolves a BioSample accession", async () => {
    const validate = new IsValidIdentifier().validationFunction();

    await expect(validate(
        {prefixes: ["biosample"]},
        "biosample:SAMEA2397676"
    )).resolves.toBe(true);
});
