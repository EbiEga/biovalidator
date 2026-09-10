jest.mock('axios');

const axios = require('axios');
const BioValidator = require('../src/core/biovalidator-core');

const VALID_DIRECTORY = 'test/resources/schema_registry/valid';
const VALID_GLOB = `${VALID_DIRECTORY}/*.json`;

describe('local reference schema registry', () => {
  beforeEach(() => {
    axios.mockReset();
  });

  test('registers directory schemas in their matching draft contexts', () => {
    const validator = new BioValidator(VALID_DIRECTORY);

    expect(validator.getSchemaInventory()).toEqual({
      registered: [
        'https://example.org/local/draft2019.json',
        'https://example.org/local/draft2020.json'
      ],
      validatorID: [],
      referenced: []
    });
    expect(validator.ajvContexts['07'].registeredSchemas.has(
        'https://example.org/local/draft2019.json'
    )).toBe(true);
    expect(validator.ajvContexts['2020'].registeredSchemas.has(
        'https://example.org/local/draft2020.json'
    )).toBe(true);
  });

  test.each([
    ['https://example.org/local/draft2019.json', {name: 'Ada'}],
    ['https://example.org/local/draft2020.json', {count: 1}]
  ])('resolves registered schema %s without a network request', async (schemaId, data) => {
    const validator = new BioValidator(VALID_GLOB);
    axios.mockRejectedValue(new Error('Network must not be used for a registered schema'));

    await expect(validator.validate({$ref: schemaId}, data)).resolves.toEqual([]);
    expect(axios).not.toHaveBeenCalled();
  });

  test('reuses a registered schema when the same $id is submitted directly', async () => {
    const validator = new BioValidator(VALID_DIRECTORY);
    const registeredSchema = validator.ajvContexts['07'].registeredSchemas.get(
        'https://example.org/local/draft2019.json'
    );

    await expect(validator.validate({...registeredSchema}, {name: 'Ada'})).resolves.toEqual([]);
    expect(validator.getSchemaInventory().validatorID).toEqual([]);
  });

  test('registered schemas survive clearing transient schema caches', () => {
    const validator = new BioValidator(VALID_DIRECTORY);
    validator.ajvContexts['2019'].validatorCache.set('transient-validator', Promise.resolve(() => true));
    validator.ajvContexts['2019'].referencedSchemaCache.set('https://example.org/remote.json', {});

    validator.clearSchemaCaches();

    expect(validator.getSchemaInventory()).toEqual({
      registered: [
        'https://example.org/local/draft2019.json',
        'https://example.org/local/draft2020.json'
      ],
      validatorID: [],
      referenced: []
    });
    expect(validator.ajvContexts['07'].ajv.getSchema(
        'https://example.org/local/draft2019.json'
    )).toEqual(expect.any(Function));
  });

  test.each([
    ['test/resources/schema_registry/invalid/missing-id.json', 'must define a non-empty $id'],
    ['test/resources/schema_registry/invalid/malformed.json', 'Failed to read local reference schema'],
    ['test/resources/schema_registry/invalid/invalid-schema.json', 'Failed to register local reference schema'],
    ['test/resources/schema_registry/duplicate/*.json', 'Duplicate local reference schema $id']
  ])('fails clearly for invalid local schema configuration: %s', (path, message) => {
    expect(() => new BioValidator(path)).toThrow(message);
  });
});
