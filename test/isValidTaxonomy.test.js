jest.mock("axios");

const axios = require("axios");
const fs = require("fs");
const BioValidator = require('../src/core/biovalidator-core');

beforeEach(() => {
  axios.mockReset();
});

test("valid taxonomy expression should pass the validation", async () => {
  let inputSchema = fs.readFileSync("examples/schemas/isValidTaxonomy-schema.json", "utf-8");
  let jsonSchema = JSON.parse(inputSchema);

  let inputObj = fs.readFileSync("examples/objects/isValidTaxonomy.json", "utf-8");
  let jsonObj = JSON.parse(inputObj);

  const schemaValidator = new BioValidator();

  axios.mockResolvedValue({
    status: 200,
    data: [{taxId: 9606, submittable: "true"}]
  });

  await expect(schemaValidator._validate(jsonSchema, jsonObj)).resolves.toEqual([]);
  expect(axios).toHaveBeenCalledTimes(1);
});

test("invalid taxonomy expresson should return an error", async () => {
  let inputSchema = fs.readFileSync("examples/schemas/isValidTaxonomy-schema.json", "utf-8");
  let jsonSchema = JSON.parse(inputSchema);

  let inputObj = fs.readFileSync("examples/objects/isInvalidTaxonomy.json", "utf-8");
  let jsonObj = JSON.parse(inputObj);

  const schemaValidator = new BioValidator()
  
  axios.mockResolvedValue({status: 200, data: []});

  const data = await schemaValidator._validate(jsonSchema, jsonObj);
  expect(data).toHaveLength(1);
  expect(data[0].message).toContain('provided taxonomy expression does not exist: [not valid taxonomy]');
  expect(axios).toHaveBeenCalledTimes(1);
});
