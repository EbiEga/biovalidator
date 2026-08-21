const IsValidTaxonomy = require("../../src/keywords/isvalidtaxonomy");

test("ENA resolves Homo sapiens taxonomy", async () => {
    const validate = new IsValidTaxonomy().keywordFunction();

    await expect(validate(true, "Homo sapiens")).resolves.toBe(true);
});
