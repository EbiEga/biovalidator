const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const BioValidator = require('../src/core/biovalidator-core');
const Pool = require('../src/core/validation-pool');
const Server = require('../src/core/server');
const {SecureHttpClient, WorkConservingSemaphore} = require('../src/utils/secure-http-client');
const {loadSecurityConfig} = require('../src/utils/security-config');
const {logger, addLogDirectory} = require('../src/utils/winston');
logger.silent = true;
const config = overrides => ({...loadSecurityConfig({}), ...overrides});
const waitFor = async condition => {
    for (let i = 0; i < 500; i++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Condition did not become true');
};

const drafts = ['http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'];
test.each(drafts)('isolates nested identifiers across requests, eviction and clear: %s', async draft => {
    const uri = 'https://raw.githubusercontent.com/example/schemas/main/target.json';
    const httpClient = {getJson: jest.fn(async () => ({status: 200, data: {$id: uri, $schema: draft, type: 'string'}}))};
    const validator = new BioValidator(null, {securityConfig: config({compiledCacheMaxEntries: 2}), httpClient});
    const ctx = validator.ajvContexts[validator._draftType({$schema: draft})];
    const baseline = Object.keys(ctx.ajv.refs).length;
    for (let i = 0; i < 5; i++) {
        await validator.validate({$schema: draft, $id: `https://example.org/root${i}`,
            $defs: {nested: {$id: uri, type: 'number'}}}, null);
    }
    expect(Object.keys(ctx.ajv.refs)).toHaveLength(baseline);
    expect(ctx.validatorCache.keys().length).toBeLessThanOrEqual(2);
    await expect(validator.validate({$schema: draft, $ref: uri}, 'valid')).resolves.toEqual([]);
    expect(httpClient.getJson).toHaveBeenCalled();
    validator.clearSchemaCaches();
    expect(ctx.ajv.refs[uri]).toBeUndefined();
});

test('isolated compilation preserves relative remote references and reuses compiled results', async () => {
    const root = 'https://raw.githubusercontent.com/example/schemas/main/schema.json';
    const child = 'https://raw.githubusercontent.com/example/schemas/main/defs/term.json';
    const schemas = {[root]: {$id: root, $schema: drafts[2], type: 'object', properties: {term: {$ref: './defs/term.json'}}},
        [child]: {$id: child, $schema: drafts[2], type: 'string'}};
    const httpClient = {getJson: jest.fn(async url => ({status: 200, data: schemas[url]}))};
    const validator = new BioValidator(null, {httpClient});
    await expect(validator.validate({$ref: root}, {term: 'yes'})).resolves.toEqual([]);
    const create = jest.spyOn(validator.ajvContexts['2020'], 'createCompiler');
    await expect(validator.validate({$ref: root}, {term: 5})).resolves.not.toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(httpClient.getJson.mock.calls.map(call => call[0])).toEqual([root, child]);
});

test('pressure guard leaves a quiet expensive request at the original deadline', async () => {
    const pool = new Pool({securityConfig: config({workers: 1, pressureTimeoutMs: 50, validationTimeoutMs: 300}), httpClient: {}});
    try {
        await pool.validate({}, null);
        await expect(pool.validate({type: 'string', pattern: '^(a+)+$'}, 'a'.repeat(40) + '!'))
            .rejects.toMatchObject({code: 'VALIDATION_TIMEOUT'});
    } finally { await pool.close(); }
}, 15000);

test('pressure guard releases a busy worker only when another request is waiting', async () => {
    const pool = new Pool({securityConfig: config({workers: 1, pressureTimeoutMs: 100, validationTimeoutMs: 5000}), httpClient: {}});
    try {
        await pool.validate({}, null);
        const expensive = pool.validate({type: 'string', pattern: '^(a+)+$'}, 'a'.repeat(40) + '!').catch(e => e.code);
        const ordinary = pool.validate({type: 'number'}, 42);
        expect(await expensive).toBe('VALIDATION_PRESSURE_LIMIT');
        await expect(ordinary).resolves.toEqual([]);
    } finally { await pool.close(); }
}, 15000);

test('waiting for providers does not trigger the pressure guard', async () => {
    let complete;
    const httpClient = {getJson: () => new Promise(resolve => { complete = () => resolve({status: 200, data: []}); })};
    const pool = new Pool({securityConfig: config({workers: 1, pressureTimeoutMs: 50}), httpClient});
    try {
        const first = pool.validate({type: 'string', isValidTaxonomy: true}, 'term');
        await waitFor(() => Boolean(complete));
        const second = pool.validate({}, null);
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(pool.workers[0].job.outboundPending).toBe(1);
        complete();
        await first;
        await expect(second).resolves.toEqual([]);
    } finally { await pool.close(); }
}, 15000);

test('outbound queue rejects excess work and releases cancelled waiters', async () => {
    const semaphore = new WorkConservingSemaphore(1, 1);
    await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal).catch(e => e.code);
    await expect(semaphore.acquire()).rejects.toMatchObject({code: 'OUTBOUND_CAPACITY_LIMIT'});
    controller.abort();
    expect(await queued).toBe('VALIDATION_CANCELLED');
    expect(semaphore.waiting).toHaveLength(0);
    semaphore.release();
    expect(semaphore.active).toBe(0);
});

test('cancelling one shared download consumer preserves the other', async () => {
    let finish, transportSignal;
    const adapter = jest.fn(options => { transportSignal = options.signal; return new Promise(resolve => { finish = () => resolve({status: 200, data: '{}'}); }); });
    const client = new SecureHttpClient({adapter});
    const controller = new AbortController();
    const url = 'https://raw.githubusercontent.com/example/schemas/main/schema.json';
    const first = client.getJson(url, {cache: true, signal: controller.signal}).catch(e => e.code);
    const second = client.getJson(url, {cache: true});
    await waitFor(() => Boolean(finish));
    controller.abort();
    expect(await first).toBe('VALIDATION_CANCELLED');
    expect(transportSignal.aborted).toBe(false);
    finish();
    await expect(second).resolves.toMatchObject({data: {}});
    expect(adapter).toHaveBeenCalledTimes(1);
});

test('worker timeout cancels both active downloads and queued downloads', async () => {
    const securityConfig = config({workers: 1, validationTimeoutMs: 500, outboundConcurrency: 1});
    const adapter = jest.fn(({signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})));
    const client = new SecureHttpClient({config: securityConfig, adapter});
    const pool = new Pool({securityConfig, httpClient: client});
    try {
        await expect(pool.validate({type: 'string', graphRestriction: {
            allChildrenOf: ['EFO:1', 'EFO:2', 'EFO:3'], ontologies: ['efo']
        }}, 'EFO:4')).rejects.toMatchObject({code: 'VALIDATION_TIMEOUT'});
        await waitFor(() => client.inFlight.size === 0);
        expect(client.semaphore.active).toBe(0);
        expect(client.semaphore.waiting).toHaveLength(0);
        expect(adapter).toHaveBeenCalledTimes(1);
    } finally { await pool.close(); }
}, 15000);

test('cancelling a queued validation frees capacity without killing the active worker', async () => {
    const pool = new Pool({securityConfig: config({workers: 1, pressureReliefEnabled: false}), httpClient: {}});
    try {
        await pool.validate({}, null);
        const runningAbort = new AbortController(), queuedAbort = new AbortController();
        const running = pool.validate({type: 'string', pattern: '^(a+)+$'}, 'a'.repeat(40)+'!', {signal: runningAbort.signal}).catch(e => e.code);
        const queued = pool.validate({}, null, {signal: queuedAbort.signal}).catch(e => e.code);
        queuedAbort.abort();
        expect(await queued).toBe('VALIDATION_CANCELLED');
        expect(pool.queue).toHaveLength(0);
        expect(pool.workers).toHaveLength(1);
        runningAbort.abort();
        expect(await running).toBe('VALIDATION_CANCELLED');
        expect(pool.workers).toHaveLength(0);
    } finally { await pool.close(); }
}, 15000);

test('liveness avoids expensive metrics and diagnostics remain rate limited', async () => {
    const server = new Server(0, null, {disableWorkers: true, securityConfig: config({rateLimitMax: 1})});
    server.withLogDir(path.join(os.tmpdir(), 'biovalidator-security-tests'))._configureServer()._configureEndpoints();
    const snapshot = jest.spyOn(server.httpClient, 'apiSnapshot');
    for (let i=0; i<5; i++) await request(server.app).get('/live').expect(200, {status: 'ok'});
    await request(server.app).get('/live').type('json').send('not JSON').expect(200);
    expect(snapshot).not.toHaveBeenCalled();
    await request(server.app).get('/health').expect(200);
    await request(server.app).get('/health').expect(429);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await request(server.app).post('/live').type('json').send('not JSON').expect(429);
});

test('both UI pages state the accepted external lookup and logging policy', async () => {
    const server = new Server(0, null, {disableWorkers: true});
    server.withLogDir(path.join(os.tmpdir(), 'biovalidator-security-tests'))._configureServer()._configureEndpoints();
    for (const page of ['/', '/index_editing.html']) {
        const response = await request(server.app).get(page).expect(200);
        expect(response.text).toContain('Do not submit identifiable or confidential metadata');
        expect(response.text).toContain('operational logs');
        expect(response.text).toContain('OLS, ENA and identifiers.org');
    }
});

test('new file logs are private and retain configured rotation limits', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biovalidator-private-logs-'));
    const transport = addLogDirectory(path.join(directory, 'logs'));
    try {
        expect(fs.statSync(path.join(directory, 'logs')).mode & 0o777).toBe(0o700);
        expect(transport.options.options.mode).toBe(0o600);
        expect(transport.options.maxFiles).toBe(14);
    } finally { logger.remove(transport); transport.close(); }
});

test.each([
    [{validationOutboundMax: 1}, 'VALIDATION_OUTBOUND_LIMIT'],
    [{validationOutboundMaxBytes: 1}, 'VALIDATION_OUTBOUND_SIZE_LIMIT']
])('enforces per-validation outbound budgets: %j', async (overrides, code) => {
    const securityConfig = config({workers: 1, ...overrides});
    const httpClient = {getJson: async () => ({status: 200, sizeBytes: 10, data: {}})};
    const pool = new Pool({securityConfig, httpClient});
    try {
        const schema = {type: 'string', graphRestriction: {
            allChildrenOf: ['EFO:1', 'EFO:2'], ontologies: ['efo']
        }};
        await expect(pool.validate(schema, 'EFO:3')).rejects.toMatchObject({code});
        expect(pool.workers).toHaveLength(0);
        expect(pool.stagedOutbound.size).toBe(0);
    } finally { await pool.close(); }
}, 15000);

test('pressure relief can be disabled without changing regex behavior', async () => {
    const pool = new Pool({securityConfig: config({workers: 1, pressureReliefEnabled: false,
        pressureTimeoutMs: 20, validationTimeoutMs: 200}), httpClient: {}});
    try {
        await pool.validate({}, null);
        const expensive = pool.validate({type: 'string', pattern: '^(a+)+$'}, 'a'.repeat(40)+'!').catch(e => e.code);
        const next = pool.validate({}, null);
        expect(await expensive).toBe('VALIDATION_TIMEOUT');
        await expect(next).resolves.toEqual([]);
    } finally { await pool.close(); }
}, 15000);

test('HTTP disconnect propagates cancellation to the validation executor', async () => {
    const http = require('http');
    let captured;
    const server = new Server(0, null, {disableWorkers: true});
    server.validationPool = {validate: (_schema, _data, {signal}) => new Promise((resolve, reject) => {
        captured = signal;
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
    })};
    server.withLogDir(path.join(os.tmpdir(), 'biovalidator-security-tests'))._configureServer()._configureEndpoints();
    const listener = server.app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const connection = http.request({host: '127.0.0.1', port: listener.address().port, path: '/validate',
        method: 'POST', headers: {'content-type': 'application/json'}});
    connection.on('error', () => {});
    try {
        connection.end(JSON.stringify({schema: {}, data: null}));
        await waitFor(() => Boolean(captured));
        connection.destroy();
        await waitFor(() => captured.aborted);
    } finally { connection.destroy(); await new Promise(resolve => listener.close(resolve)); }
});

test.each([false, true])('forwarded addresses affect quotas only through a trusted proxy: %s', async trusted => {
    const previous = process.env.BIOVALIDATOR_TRUST_PROXY;
    try {
        process.env.BIOVALIDATOR_TRUST_PROXY = trusted ? '127.0.0.1/32,::1/128' : '192.0.2.0/24';
        const server = new Server(0, null, {disableWorkers: true, securityConfig: config({rateLimitMax: 1})});
        server.withLogDir(path.join(os.tmpdir(), 'biovalidator-security-tests'))._configureServer()._configureEndpoints();
        await request(server.app).get('/validate').set('X-Forwarded-For', '198.51.100.1').expect(200);
        await request(server.app).get('/validate').set('X-Forwarded-For', '198.51.100.2').expect(trusted ? 200 : 429);
        await request(server.app).get('/validate').set('X-Forwarded-For', '198.51.100.1').expect(429);
    } finally {
        if (previous === undefined) delete process.env.BIOVALIDATOR_TRUST_PROXY;
        else process.env.BIOVALIDATOR_TRUST_PROXY = previous;
    }
});

test('failed compilation cannot poison a later schema using a nested identifier', async () => {
    const validator = new BioValidator();
    const nested = 'https://example.org/nested';
    await expect(validator.validate({$id: 'https://example.org/failure', $defs: {x: {$id: nested}}, type: 'invalid'}, null))
        .rejects.toMatchObject({code: 'SCHEMA_COMPILATION_FAILED'});
    await expect(validator.validate({$id: nested, type: 'number'}, 42)).resolves.toEqual([]);
});

test('isolated compilers resolve local IDs with an empty fragment without going online', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biovalidator-local-fragment-'));
    const uri = 'https://example.org/local.json';
    fs.writeFileSync(path.join(directory, 'schema.json'), JSON.stringify({$id: uri + '#', type: 'number'}));
    const httpClient = {getJson: jest.fn(() => { throw new Error('Local schema must not be fetched'); })};
    try {
        const validator = new BioValidator(directory, {httpClient});
        await expect(validator.validate({$ref: uri}, 42)).resolves.toEqual([]);
        expect(httpClient.getJson).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
