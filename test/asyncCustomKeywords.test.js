jest.mock("axios");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const BioValidator = require("../src/core/biovalidator-core");
const {installDefaultOlsMock} = require("./olsTestUtils");

/**
 * In this test, we check how Biovalidator behaves when JSON Schemas
 * contain '$async' at the root (true, missing, false) in conjunction
 * with or without a custom keyword. The only scenario that should 
 * fail is when '$async' is explicitly false AND a custom keyword is in use.
 */

describe("asyncCustomKeywords test suite", () => {
  let biovalidator;

  beforeEach(() => {
    axios.mockReset();
    installDefaultOlsMock(axios);
    // Recreate a brand-new instance for each test. It's required so that we can re-use the same
    // schema (graphRestriction-schema.json) while changing properties inside on the fly.
    // Without cleaning cache, Biovalidator simply reuses the first compiled schema with that $id.
    biovalidator = new BioValidator();
  });

  test("Scenario #1: `$async: true` + custom keyword => valid", () => {
    const schemaPath = path.join(__dirname, "..", "examples", "schemas", "graphRestriction-schema.json");
    const schemaOriginal = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  
    // Ensure `$async` is explicitly true at the root:
    const schema = { ...schemaOriginal, $async: true };
  
    // Load a valid data object that exercises the custom keyword:
    const dataPath = path.join(__dirname, "..", "examples", "objects", "graphRestriction_pass.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  
    return biovalidator.validate(schema, data).then(errors => {
      expect(errors).toBeDefined();
      expect(errors.length).toBe(0); // must pass
    });
  });
  
  test("Scenario #2: missing `$async` + custom keyword => valid", () => {
    const schemaPath = path.join(__dirname, "..", "examples", "schemas", "graphRestriction-schema.json");
    const schemaOriginal = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  
    // Remove any `$async` at root if it exists:
    const schema = { ...schemaOriginal };
    delete schema.$async;
  
    const dataPath = path.join(__dirname, "..", "examples", "objects", "graphRestriction_pass.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  
    return biovalidator.validate(schema, data).then(errors => {
      expect(errors).toBeDefined();
      expect(errors.length).toBe(0); // must pass after injection
    });
  });
  
  
  test("Scenario #3: `$async: false` + NO custom keyword => valid", () => {
    // We reuse a simple schema that doesn't rely on custom keywords (e.g. test-schema.json).
    const schemaPath = path.join(__dirname, "..", "examples", "schemas", "test-schema.json");
    const schemaOriginal = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  
    // Force `$async` = false
    const schema = { ...schemaOriginal, $async: false };
  
    // Provide some minimal data that meets the schema
    const data = {
      name: "No custom keywords scenario",
      characteristics: {
        species: [
          {
            text: "Homo sapiens" // Enough to satisfy 'nonEmptyString'
          }
        ]
      }
    };
  
    return biovalidator.validate(schema, data).then(errors => {
      expect(errors).toBeDefined();
      expect(errors.length).toBe(0); // must pass
    });
  });
  
  test("Scenario #4: `$async: false` + custom keyword => should fail", () => {
    const schemaPath = path.join(__dirname, "..", "examples", "schemas", "graphRestriction-schema.json");
    const schemaOriginal = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    const schema = { ...schemaOriginal, $async: false };
  
    const dataPath = path.join(__dirname, "..", "examples", "objects", "graphRestriction_pass.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  
    return biovalidator.validate(schema, data).then(
      // success callback:
      () => {
        // If we get here, that means no compile error occurred, which is unexpected.
        // So forcibly fail:
        fail("Expected compile/validation error ('$async' was 'false' but used AJV's async features), but validation passed unexpectedly.");
      },
      // failure callback:
      (err) => {
        expect(err).toBeDefined();
        expect(err.error).toContain("Failed to compile schema");
      }
    );
  });  
});
