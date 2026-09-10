const BioValidator = require('../src/core/biovalidator-core');
const {loadSecurityConfig} = require('../src/utils/security-config');
const {SecureHttpClient} = require('../src/utils/secure-http-client');
const Graph = require('../src/keywords/graphRestriction');
const Taxonomy = require('../src/keywords/isvalidtaxonomy');
const Term = require('../src/keywords/isvalidterm');
const Identifier = require('../src/keywords/isvalididentifier');
const {logger} = require('../src/utils/winston');
logger.silent = true;

test.each(['06', '07'])('A1: draft %s ignores constraints beside a reference', async draft => {
    const validator = new BioValidator();
    const schema = {$schema: `http://json-schema.org/draft-${draft}/schema#`,
        $ref: '#/definitions/anything', type: 'string', definitions: {anything: {}}};
    await expect(validator.validate(schema, 42)).resolves.toEqual([]);
    await expect(validator.validate({...schema, $schema: 'https://json-schema.org/draft/2019-09/schema'}, 42))
        .resolves.not.toEqual([]);
});

test('A2: strict checking accepts configured annotations and rejects misspelled rules', async () => {
    const securityConfig = loadSecurityConfig({BIOVALIDATOR_SCHEMA_STRICT: 'true',
        BIOVALIDATOR_ANNOTATION_KEYWORDS: 'meta:enum,meta:version,project:note'});
    const validator = new BioValidator(null, {securityConfig});
    await expect(validator.validate({type: 'string', 'meta:enum': ['x'], 'meta:version': 1, 'project:note': 'text'}, 'x'))
        .resolves.toEqual([]);
    await expect(validator.validate({type: 'string', minLenght: 4}, ''))
        .rejects.toMatchObject({code: 'SCHEMA_COMPILATION_FAILED', status: 422});
});

test('P1/P2: unique schemas remain bounded, survive eviction, and clear without retained Ajv roots', async () => {
    const securityConfig = {...loadSecurityConfig({}), compiledCacheMaxEntries: 2};
    const validator = new BioValidator(null, {securityConfig});
    const ctx = validator.ajvContexts['2019'];
    const baseline = ctx.ajv._cache.size;
    for (let i = 0; i < 30; i++) {
        await expect(validator.validate({type: 'string', description: String(i)}, 'x')).resolves.toEqual([]);
        expect(ctx.validatorCache.keys().length).toBeLessThanOrEqual(2);
        expect(ctx.ajv._cache.size).toBe(baseline);
    }
    validator.clearSchemaCaches();
    expect(ctx.validatorMetadata.size).toBe(0);
    expect(ctx.ajv._cache.size).toBe(baseline);
    await expect(validator.validate({type: 'number'}, 'wrong')).resolves.not.toEqual([]);
});

test.each([{relations: ['part_of']}, {direct: true}, {direct: false}, {classes: ['https://example.org/a']}])('R1: unsupported graph option %j is rejected before network use', async options => {
    const graph = new Graph();
    graph.olsClient.resolveUniqueIri = jest.fn();
    await expect(graph.keywordFunction()({allChildrenOf: ['https://example.org/a'], ontologies: ['x'], ...options}, 'x'))
        .rejects.toMatchObject({code: 'GRAPH_RESTRICTION_OPTION_UNSUPPORTED', message: expect.stringContaining('OLS')});
    expect(graph.olsClient.resolveUniqueIri).not.toHaveBeenCalled();
});

test.each([new Error('DNS failed'), {response: {status: 503}}, {response: {status: 429}}])('R3: provider failures stay execution failures', async error => {
    const httpClient = {getJson: jest.fn().mockRejectedValue(error)};
    const validator = new BioValidator(null, {httpClient});
    await expect(validator.validate({type: 'string', isValidTaxonomy: true}, 'human'))
        .rejects.toMatchObject({status: 502, code: 'UPSTREAM_UNAVAILABLE'});
    await expect(validator.validate({type: 'string', isValidIdentifier: {prefix: 'pubmed'}}, '123'))
        .rejects.toMatchObject({status: 502, code: 'UPSTREAM_UNAVAILABLE'});
});

test('R3: malformed provider content is not evidence of invalid data', async () => {
    const httpClient = {getJson: async () => ({status: 200, data: {unexpected: true}})};
    await expect(new Taxonomy(null, {httpClient}).keywordFunction()(true, 'human'))
        .rejects.toMatchObject({code: 'UPSTREAM_RESPONSE_INVALID'});
    await expect(new Identifier({httpClient}).validationFunction()({prefix: 'pubmed'}, '123'))
        .rejects.toMatchObject({code: 'UPSTREAM_RESPONSE_INVALID'});
});

test('R4: null returns ordinary validation errors without an unhandled rejection', async () => {
    const validator = new BioValidator();
    await expect(validator.validate({type: 'string'}, null)).resolves.toEqual([
        expect.objectContaining({errors: ['must be string']})
    ]);
});

test.each([false, 'false'])('R6: %j disables taxonomy and ontology lookup', async value => {
    const httpClient = {getJson: jest.fn()};
    await expect(new Taxonomy(null, {httpClient}).keywordFunction()(value, 'human')).resolves.toBe(true);
    await expect(new Term(null, null, {httpClient}).keywordFunction()(value, 'human')).resolves.toBe(true);
    expect(httpClient.getJson).not.toHaveBeenCalled();
});

test.each([true, false])('R7: remote boolean schema %s is accepted only for schema requests', async value => {
    const client = new SecureHttpClient({adapter: async () => ({status: 200, data: JSON.stringify(value)})});
    const validator = new BioValidator(null, {httpClient: client});
    const errors = await validator.validate({$ref: 'https://raw.githubusercontent.com/a/b/main/test.json'}, 42);
    expect(errors.length === 0).toBe(value);
    await expect(client.getJson('https://www.ebi.ac.uk/ena/taxonomy/rest/any-name/x', {kind: 'ena'}))
        .rejects.toMatchObject({code: 'UPSTREAM_JSON_INVALID'});
});

test('S3: large validation results are rejected with explicit limits', async () => {
    const validator = new BioValidator(null, {securityConfig: {...loadSecurityConfig({}), validationMaxErrors: 2}});
    await expect(validator.validate({type: 'array', items: {type: 'number'}}, ['a', 'b', 'c']))
        .rejects.toMatchObject({code: 'VALIDATION_ERROR_LIMIT'});
    const small = new BioValidator(null, {securityConfig: {...loadSecurityConfig({}), validationResultMaxBytes: 10}});
    await expect(small.validate({type: 'number'}, 'a')).rejects.toMatchObject({code: 'VALIDATION_RESULT_SIZE_LIMIT'});
});


test.each(['childrenOf', 'allChildrenOf'])('R1: %s is passed to OLS without translation', async field => {
    const graph = new Graph();
    graph.olsClient.resolveUniqueIri = jest.fn().mockResolvedValue('iri');
    await graph.keywordFunction()({[field]: ['https://example.org/a'], ontologies: ['x']}, 'X:1');
    expect(graph.olsClient.resolveUniqueIri).toHaveBeenCalledWith('X:1', ['obo_id'], {
        [field]: 'https://example.org/a', ontology: 'x'
    });
});

test('A1: an unversioned remote wrapper selects the referenced schema draft', async () => {
    const uri = 'https://raw.githubusercontent.com/a/b/main/legacy.json';
    const schema = {$id: uri, $schema: 'http://json-schema.org/draft-07/schema#',
        $ref: '#/definitions/anything', minLength: 10, definitions: {anything: {}}};
    const httpClient = {getJson: jest.fn().mockResolvedValue({status: 200, data: schema, sizeBytes: 200})};
    await expect(new BioValidator(null, {httpClient}).validate({$ref: uri}, '')).resolves.toEqual([]);
    expect(httpClient.getJson).toHaveBeenCalledTimes(1);
});

test('P1: failed compilation does not retain roots or poison future cache use', async () => {
    const validator = new BioValidator(null, {securityConfig: {...loadSecurityConfig({}), compiledCacheMaxEntries: 2}});
    const ctx = validator.ajvContexts['2019'];
    const baseline = ctx.ajv._cache.size;
    for (let i = 0; i < 5; i++) {
        await expect(validator.validate({type: 'unknown', description: String(i)}, 'x')).rejects.toBeDefined();
    }
    expect(ctx.ajv._cache.size).toBe(baseline);
    await expect(validator.validate({type: 'string'}, 'x')).resolves.toEqual([]);
});

test('R1: a remote FEGA-style relation restriction fails explicitly rather than approving data', async () => {
    const uri = 'https://raw.githubusercontent.com/a/b/main/schema.json';
    const httpClient = {getJson: jest.fn().mockResolvedValue({status: 200, data: {
        $id: uri, $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string',
        graphRestriction: {classes: ['EFO:0001426'], ontologies: ['obo:efo'], relations: ['rdfs:subClassOf'], direct: false}
    }})};
    await expect(new BioValidator(null, {httpClient}).validate({$ref: uri}, 'EFO:0000001'))
        .rejects.toMatchObject({code: 'SCHEMA_COMPILATION_FAILED', status: 422});
    expect(httpClient.getJson).toHaveBeenCalledTimes(1);
});

test('P1: registered local schemas can still resolve remote dependencies asynchronously', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biovalidator-local-ref-'));
    const uri = 'https://raw.githubusercontent.com/a/b/main/number.json';
    fs.writeFileSync(path.join(directory, 'schema.json'), JSON.stringify({
        $id: 'urn:local:audit', $schema: 'http://json-schema.org/draft-07/schema#', $ref: uri
    }));
    try {
        const httpClient = {getJson: jest.fn().mockResolvedValue({status: 200, data: {
            $id: uri, $schema: 'http://json-schema.org/draft-07/schema#', type: 'number'
        }})};
        const validator = new BioValidator(directory, {httpClient});
        const schema = validator.ajvContexts['07'].registeredSchemas.get('urn:local:audit');
        await expect(validator.validate(schema, 42)).resolves.toEqual([]);
        await expect(validator.validate(schema, 'wrong')).resolves.not.toEqual([]);
        expect(httpClient.getJson).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
