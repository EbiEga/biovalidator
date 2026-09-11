const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {spawnSync} = require('child_process');
const supertest = require('supertest');
const Server = require('../src/core/server');
const Pool = require('../src/core/validation-pool');
const {loadSecurityConfig} = require('../src/utils/security-config');
const {logger, addLogDirectory} = require('../src/utils/winston');
logger.silent = true;
const root = path.resolve(__dirname, '..');

function server(options = {}) {
    const instance = new Server(0, null, {disableWorkers: true, ...options});
    instance.withLogDir(path.join(os.tmpdir(), 'biovalidator-operation-tests'));
    instance._configureServer()._configureEndpoints();
    return instance;
}

test('S1/S5: administration is opt-in and health never exposes cached data values', async () => {
    const instance = server({environment: {}});
    const request = supertest(instance.app);
    instance.httpClient.remoteCache.set('remoteSchema:https://raw.githubusercontent.com/a/b/main/schema.json',
        {data: {secret: 'private-data-sentinel'}}, {weight: 30});
    instance.httpClient.apiCache.set('ena:https://www.ebi.ac.uk/ena/taxonomy/rest/any-name/private-data-sentinel',
        {data: {secret: 'private-data-sentinel'}}, {weight: 30});
    await request.delete('/cache').expect(404);
    const health = await request.get('/health').expect(200);
    expect(health.text).not.toContain('private-data-sentinel');
    expect(health.text).toContain('https://raw.githubusercontent.com/a/b/main/schema.json');
    const enabled = server({environment: {BIOVALIDATOR_CACHE_ENDPOINT_ENABLED: 'true'}});
    await supertest(enabled.app).delete('/cache').expect(200);
});

test('S2: configured rate limit rejects before parsing and resets after its window', async () => {
    const securityConfig = {...loadSecurityConfig({}), rateLimitWindowMs: 1000, rateLimitMax: 1};
    const instance = server({securityConfig});
    const request = supertest(instance.app);
    await request.post('/validate').send({schema: {}, data: {}}).expect(200);
    const rejected = await request.post('/validate').type('json').send('malformed').expect(429);
    expect(rejected.body.code).toBe('REQUEST_RATE_LIMIT');
    expect(rejected.headers['retry-after']).toBeDefined();
    await request.get('/live').expect(200);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await request.post('/validate').send({schema: {}, data: {}}).expect(200);
});

test('S2: limits can be changed or disabled without source changes', async () => {
    const securityConfig = loadSecurityConfig({BIOVALIDATOR_RATE_LIMIT_ENABLED: 'false',
        BIOVALIDATOR_RATE_LIMIT_MAX: '1', BIOVALIDATOR_MAX_CONNECTIONS: '5', BIOVALIDATOR_REQUEST_TIMEOUT_MS: '2000'});
    const instance = server({securityConfig});
    await supertest(instance.app).get('/validate').expect(200);
    await supertest(instance.app).get('/validate').expect(200);
    instance.port = 0;
    instance._startServer();
    try {
        expect(instance.expressServer.maxConnections).toBe(5);
        expect(instance.expressServer.requestTimeout).toBe(2000);
    } finally {
        await new Promise(resolve => instance.expressServer.close(resolve));
    }
});

test('S4: a deeply nested schema is rejected before hashing or starting a worker', async () => {
    const pool = new Pool({securityConfig: loadSecurityConfig({}), httpClient: {}});
    let schema = {};
    for (let i = 0; i < 12000; i++) schema = {allOf: [schema]};
    await expect(pool.validate(schema, {})).rejects.toMatchObject({code: 'SCHEMA_DEPTH_LIMIT'});
    expect(pool.workers).toHaveLength(0);
    await pool.close();
});

test('S3/P1: workers enforce configured heap limits and bound routing history', async () => {
    const securityConfig = {...loadSecurityConfig({}), workers: 1, workerHeapMb: 128, compiledCacheMaxEntries: 2};
    const pool = new Pool({securityConfig, httpClient: {}});
    try {
        for (let i = 0; i < 5; i++) await pool.validate({type: 'number', description: String(i)}, 42);
        expect(pool.workers[0].worker.resourceLimits.maxOldGenerationSizeMb).toBe(128);
        expect(pool.workers[0].digests.size).toBe(2);
    } finally { await pool.close(); }
}, 30000);

test('P3: responses completing after worker removal are not retained', async () => {
    let finish;
    const httpClient = {getJson: (url, options) => new Promise(resolve => {
        finish = () => { options.cacheSink.push({response: {data: 'late'}}); resolve({data: {}}); };
    })};
    const pool = new Pool({securityConfig: loadSecurityConfig({}), httpClient});
    const slot = {intentional: false, job: {id: 1, controller: new AbortController(), outboundCalls: 0, outboundPending: 0, outboundBytes: 0}};
    pool.workers.push(slot);
    pool._onMessage(slot, {type: 'outbound', jobId: 1, url: 'mock', requestId: 1, options: {deferCache: true}});
    pool.workers = [];
    slot.intentional = true;
    finish();
    await new Promise(resolve => setImmediate(resolve));
    expect(pool.stagedOutbound.size).toBe(0);
    await pool.close();
});

test('R2: real CLI exits distinguish valid, invalid, missing files, and falsy JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biovalidator-cli-'));
    const schema = path.join(dir, 'schema.json');
    const data = path.join(dir, 'data.json');
    try {
        for (const [rule, value, code] of [[true, false, 0], [true, 0, 0], [true, null, 0], [false, {}, 1], [{type: 'number'}, 'x', 1], [{type: 'made-up'}, {}, 2]]) {
            fs.writeFileSync(schema, JSON.stringify(rule));
            fs.writeFileSync(data, JSON.stringify(value));
            const result = spawnSync(process.execPath, [path.join(root, 'src/biovalidator.js'), '--schema', schema, '--data', data], {timeout: 15000, encoding: 'utf8'});
            expect({status: result.status, error: result.error?.message}).toEqual({status: code, error: undefined});
        }
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}, 90000);

test('R5: editing or issuing a newer request prevents an older verdict from being accepted', () => {
    const source = fs.readFileSync(path.join(root, 'src/browser/validation-state.mjs'), 'utf8');
    const State = vm.runInNewContext(source.replace('export class', 'class') + '\nValidationState;');
    const state = new State();
    const old = state.begin();
    expect(state.pending).toBe(true);
    state.invalidate();
    expect(state.isCurrent(old)).toBe(false);
    const latest = state.begin();
    expect(state.finish(old)).toBe(false);
    expect(state.pending).toBe(true);
    expect(state.finish(latest)).toBe(true);
    expect(state.pending).toBe(false);
});

test('D1: active file transport has size and file-count bounds', () => {
    const transport = addLogDirectory(path.join(os.tmpdir(), 'biovalidator-rotation-tests'));
    expect(transport.options.maxSize).toBe(20 * 1024 * 1024);
    expect(transport.options.maxFiles).toBe(14);
    logger.remove(transport);
    transport.close();
});

test('D3: prefixed UI redirects without breaking query strings, assets, or validation', async () => {
    const instance = new Server(0, null, {disableWorkers: true});
    instance.withBaseUrl('/biovalidator').withLogDir(path.join(os.tmpdir(), 'biovalidator-prefix-tests'));
    instance._configureServer()._configureEndpoints();
    const request = supertest(instance.app);
    await request.get('/biovalidator?x=1').expect(308).expect('Location', '/biovalidator/?x=1');
    await request.get('/biovalidator/').expect(200);
    await request.get('/biovalidator/assets/ui.min.js').expect(200);
    await request.post('/biovalidator/validate').send({schema: {}, data: null}).expect(200, []);
});

test('D5: readiness fails on worker failure or draining while liveness remains available', async () => {
    const pool = new Pool({securityConfig: loadSecurityConfig({}), httpClient: {}});
    const instance = server({validationPool: pool});
    const request = supertest(instance.app);
    await request.get('/ready').expect(200);
    pool.lastFailureAt = Date.now();
    await request.get('/ready').expect(503);
    await request.get('/live').expect(200);
    pool.lastFailureAt = null;
    instance.draining = true;
    await request.get('/ready').expect(503);
    await request.post('/validate').send({schema: {}, data: {}}).expect(503);
    await request.get('/live').expect(200);
    await pool.close();
});

test('D6: CI can render an exact build without editing the development manifest', () => {
    const original = fs.readFileSync(path.join(root, 'k8s/deployment.yaml'), 'utf8');
    const rendered = spawnSync('sh', ['scripts/ci/render-deployment.sh'], {cwd: root, encoding: 'utf8', env: {...process.env, DEPLOY_IMAGE: 'registry.example/biovalidator:main-abc123'}});
    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toContain('image: "registry.example/biovalidator:main-abc123"');
    expect(fs.readFileSync(path.join(root, 'k8s/deployment.yaml'), 'utf8')).toBe(original);
});

test('D2: publication smoke script exercises a live HTTP server including real workers', async () => {
    const {promisify} = require('util');
    const execFile = promisify(require('child_process').execFile);
    const instance = new Server(0, null, {securityConfig: {...loadSecurityConfig({}), workers: 1}});
    instance.withBaseUrl('/biovalidator').withLogDir(path.join(os.tmpdir(), 'biovalidator-smoke-tests'));
    instance._configureServer()._configureEndpoints();
    instance.port = 0;
    instance._startServer();
    try {
        await new Promise(resolve => instance.expressServer.listening ? resolve() : instance.expressServer.once('listening', resolve));
        const base = `http://127.0.0.1:${instance.expressServer.address().port}/biovalidator`;
        const result = await execFile(process.execPath, ['scripts/ci/smoke-server.js'], {
            cwd: root, env: {...process.env, SMOKE_URL: base}, timeout: 30000
        });
        expect(result.stdout).toContain('smoke checks passed');
    } finally {
        await new Promise(resolve => instance.expressServer.close(resolve));
        await instance.validationPool.close();
    }
}, 40000);
