const BioValidatorCLI = require("../src/core/cli")

test("Using wrong parameters returns an execution failure", async () => {
    const cli = new BioValidatorCLI("schema/not_exists.json", "json/not_exists.json");
    await expect(cli.validate()).resolves.toBe(2);
});

test( "Invalid JSON should result with validation error", () => {
    const schema = "test/resources/cli/test_schema.json";
    const json = "test/resources/cli/invalid.json";
    const cli = new BioValidatorCLI(schema, json);
    const jsonErrors = [
        {
            "dataPath": ".alias",
            "errors": [
                "must have required property 'alias'"
            ]
        },
        {
            "dataPath": ".taxonId",
            "errors": [
                "must have required property 'taxonId'"
            ]
        }
    ]

    const expectedErrorOutput = ".alias\n" +
        "\tmust have required property 'alias'\n" +
        ".taxonId\n" +
        "\tmust have required property 'taxonId'\n";

    let errorOutput = cli.error_report(jsonErrors);

    expect(errorOutput).toBeDefined();
    expect(errorOutput).toEqual(expectedErrorOutput)

});

test("Should be able to reference schemas from a directory", async () => {
    const cli = new BioValidatorCLI("test/resources/ref_test_schema.json", "test/resources/ref_test_valid.json", "test/resources/schema_dir/*");
    await expect(cli.validate()).resolves.toBe(0);
});
