jest.mock("axios");

const fs = require("fs");
const {EventEmitter} = require("events");
const childProcess = require("child_process");
const npid = require("npid");
const axios = require("axios");
const {
  olsCache,
  enaTaxonomyCache,
  identifiersCache,
  clearApiCaches
} = require('../src/keywords/shared-cache');

const BioValidatorServer = require('../src/core/server');
const {
  resolveDeploymentMetadata,
  resolveDependencyVersions,
  isCacheEndpointEnabled,
  SHUTDOWN_SIGNALS
} = BioValidatorServer;
const supertest = require('supertest');
const {loadSecurityConfig} = require('../src/utils/security-config');
const server = new BioValidatorServer("3020", "");
server._configureServer()._configureEndpoints();
const requestWithSupertest = supertest(server.app);

describe('biovalidator server endpoints', () => {
  beforeEach(() => {
    axios.mockReset();
    server.fegaExamplesClient.clearCache();
    server.lastExamplesRefreshAt = 0;
  });

  afterAll(done => {
    server.fegaExamplesClient.clearCache();
    if (server.expressServer) {
      server.expressServer.close();
    }
    npid.remove(server.pidPath);
    done();
  });

  it('GET / should serve EGA endpoint UI with FEGA example controls', async () => {
    const res = await requestWithSupertest.get('/');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('html'));
    expect(res.text).toContain('EGA Biovalidator endpoint');
    expect(res.text).toContain('assets/ega-logo.png');
    expect(res.text).toContain('alt="EGA logo"');
    expect(res.text).toContain('assets/ui.min.css');
    expect(res.text).toContain('assets/ui.min.js');
    expect(res.text).not.toContain('ajax.googleapis.com');
    expect(res.text).not.toContain('cdn.jsdelivr.net');
    expect(res.text).toContain('id="example-select"');
    expect(res.text).toContain('id="fetch-examples"');
    expect(res.text).toContain('id="load-example"');
    expect(res.text).toContain('FEGA metadata technical report');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    const nonce = res.text.match(/name="biovalidator-csp-nonce" content="([^"]+)"/)[1];
    expect(nonce).toBeTruthy();
    expect(res.headers['content-security-policy']).toContain(`'nonce-${nonce}'`);
    expect(res.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('uses a fresh matching CSP nonce for each HTML UI response', async () => {
    const first = await requestWithSupertest.get('/');
    const second = await requestWithSupertest.get('/index_editing.html');
    const firstNonce = first.text.match(/name="biovalidator-csp-nonce" content="([^"]+)"/)[1];
    const secondNonce = second.text.match(/name="biovalidator-csp-nonce" content="([^"]+)"/)[1];

    expect(firstNonce).not.toBe(secondNonce);
    expect(first.headers['content-security-policy']).toContain(`'nonce-${firstNonce}'`);
    expect(second.headers['content-security-policy']).toContain(`'nonce-${secondNonce}'`);
    expect(second.headers['cache-control']).toBe('no-store');
  });

  it('returns an informative Biovalidator limit response for oversized JSON bodies', async () => {
    const limitedServer = new BioValidatorServer("3028", "", {
      securityProfile: 'compatible',
      disableWorkers: true,
      securityConfig: {...loadSecurityConfig({}), requestMaxBytes: 128}
    });
    limitedServer._configureServer()._configureEndpoints();

    const res = await supertest(limitedServer.app).post('/validate').send({
      schema: {type: 'string'},
      data: 'x'.repeat(256)
    });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: 'REQUEST_BODY_SIZE_LIMIT',
      configuration: 'BIOVALIDATOR_REQUEST_MAX_BYTES',
      help: expect.stringContaining('Deploy Biovalidator locally')
    });
  });

  it('GET / should serve the self-hosted browser assets', async () => {
    const javascript = await requestWithSupertest.get('/assets/ui.min.js');
    const stylesheet = await requestWithSupertest.get('/assets/ui.min.css');
    const logo = await requestWithSupertest.get('/assets/ega-logo.png');

    expect(javascript.status).toEqual(200);
    expect(javascript.type).toEqual(expect.stringContaining('javascript'));
    expect(javascript.text).toContain('Valid JSON syntax.');
    expect(javascript.text).toContain('Check the JSON syntax in both editors before validating.');
    expect(javascript.text).toContain('cspNonce');
    expect(javascript.text).toContain('Validation error details');
    expect(javascript.text).toContain('Please wait');
    expect(stylesheet.status).toEqual(200);
    expect(stylesheet.type).toEqual(expect.stringContaining('css'));
    expect(stylesheet.text).toContain('.button-tooltip');
    expect(stylesheet.text).toContain('.btn.example-ready');
    expect(stylesheet.text).toContain('.result-editor');
    expect(logo.status).toEqual(200);
    expect(logo.type).toEqual(expect.stringContaining('png'));
  });

  it('GET /index_editing.html should use the same local editor assets', async () => {
    const res = await requestWithSupertest.get('/index_editing.html');

    expect(res.status).toEqual(200);
    expect(res.text).toContain('class="bg-light editing-layout"');
    expect(res.text).toContain('assets/ui.min.js');
    expect(res.text).toContain('assets/ega-logo.png');
    expect(res.text).toContain('data-tooltip="Fetch minimal valid FEGA examples."');
    expect(res.text).not.toContain('ajax.googleapis.com');
    expect(res.text).not.toContain('cdn.jsdelivr.net');
  });

  it('GET / should serve bundled UI when started from another working directory', async () => {
    const originalCwd = process.cwd();
    try {
      process.chdir('/tmp');
      const cwdServer = new BioValidatorServer("3021", "");
      cwdServer._configureServer()._configureEndpoints();
      const res = await supertest(cwdServer.app).get('/');

      expect(res.status).toEqual(200);
      expect(res.type).toEqual(expect.stringContaining('html'));
      expect(res.text).toContain('EGA Biovalidator endpoint');
      expect(res.text).toContain('id="fetch-examples"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('GET /validate should describe the EGA endpoint request shape', async () => {
    const res = await requestWithSupertest.get('/validate');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.message).toContain('EGA Biovalidator endpoint');
    expect(res.body.example_post_body.schema).toEqual({
      "$ref": "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/cohort/schema.json"
    });
    expect(res.body.example_post_body.data).toMatchObject({
      "@type": "ega:cohort",
      id: "ega:EGAH00000000001"
    });
  });

  it('POST /validate accepts present falsy JSON values', async () => {
    const res = await requestWithSupertest.post('/validate').send({schema: {}, data: null});

    expect(res.status).toEqual(200);
    expect(res.body).toEqual([]);
  });

  it('POST /validate still rejects a missing schema or data field', async () => {
    const res = await requestWithSupertest.post('/validate').send({schema: {}});

    expect(res.status).toEqual(400);
    expect(res.body.error).toContain("provide both 'schema' and 'data'");
  });

  it('POST /validate identifies the unresolved remote $ref', async () => {
    const res = await requestWithSupertest.post('/validate').send({
      schema: {$ref: 'pepito'},
      data: {}
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'OUTBOUND_URL_INVALID',
      reference: 'pepito',
      error: expect.stringContaining("remote $ref 'pepito'")
    });
  });

  it('GET /examples returns dynamically fetched FEGA examples', async () => {
    axios.mockImplementation((config) => {
      if (config.url.includes('/git/trees/')) {
        return Promise.resolve({
          data: {
            tree: [
              {
                path: 'schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json',
                type: 'blob'
              },
              {
                path: 'schemas/entities/cohort/examples/valid/cohort-valid-detailed-study-defined.json',
                type: 'blob'
              }
            ]
          }
        });
      }
      return Promise.resolve({
        data: {
          schema: {
            "$ref": "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/cohort/schema.json"
          },
          data: {
            "@type": "ega:cohort",
            id: "ega:EGAH00000000001"
          }
        }
      });
    });

    const res = await requestWithSupertest.get('/examples');

    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toMatchObject({
      source: 'EGA-archive/fega-metadata-schema',
      ref: 'main',
      pattern: 'schemas/entities/*/examples/valid/*minimal*.json'
    });
    expect(res.body.examples).toHaveLength(1);
    expect(res.body.examples[0]).toMatchObject({
      id: 'cohort-valid-minimal-study-defined',
      entity: 'cohort',
      name: 'cohort-valid-minimal-study-defined.json',
      schema: {
        "$ref": "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/cohort/schema.json"
      },
      data: {
        "@type": "ega:cohort",
        id: "ega:EGAH00000000001"
      }
    });
  });

  it('GET /examples uses the FEGA examples cache on repeated requests', async () => {
    axios.mockImplementation((config) => {
      if (config.url.includes('/git/trees/')) {
        return Promise.resolve({
          data: {
            tree: [
              {
                path: 'schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json',
                type: 'blob'
              }
            ]
          }
        });
      }
      return Promise.resolve({
        data: {
          schema: {"$ref": "https://example.org/schema.json"},
          data: {"@type": "ega:cohort"}
        }
      });
    });

    await requestWithSupertest.get('/examples');
    await requestWithSupertest.get('/examples');

    expect(axios).toHaveBeenCalledTimes(2);
  });

  it('GET /examples refresh=true bypasses the cache and rate-limits repeated refreshes', async () => {
    axios.mockImplementation((config) => {
      if (config.url.includes('/git/trees/')) {
        return Promise.resolve({
          data: {
            tree: [
              {
                path: 'schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json',
                type: 'blob'
              }
            ]
          }
        });
      }
      return Promise.resolve({
        data: {
          schema: {"$ref": "https://example.org/schema.json"},
          data: {"@type": "ega:cohort"}
        }
      });
    });

    const first = await requestWithSupertest.get('/examples?refresh=true');
    const second = await requestWithSupertest.get('/examples?refresh=true');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('EXAMPLES_REFRESH_RATE_LIMIT');
    expect(second.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(second.headers['retry-after']).toBe(String(second.body.retry_after_seconds));
    expect(second.body.error).toContain('before refreshing the FEGA examples');
    expect(second.body.help).toContain('Deploy Biovalidator locally');
    expect(axios).toHaveBeenCalledTimes(2);
  });

  it('GET /examples preserves the previous payload when a forced refresh fails', async () => {
    axios.mockImplementation((config) => {
      if (config.url.includes('/git/trees/')) {
        return Promise.resolve({
          data: {
            tree: [{
              path: 'schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json',
              type: 'blob'
            }]
          }
        });
      }
      return Promise.resolve({
        data: {
          schema: {"$ref": "https://example.org/schema.json"},
          data: {"@type": "ega:cohort"}
        }
      });
    });

    const initial = await requestWithSupertest.get('/examples');
    axios.mockRejectedValue(new Error('GitHub unavailable'));

    const failedRefresh = await requestWithSupertest.get('/examples?refresh=true');
    const retained = await requestWithSupertest.get('/examples');

    expect(initial.status).toBe(200);
    expect(failedRefresh.status).toBe(502);
    expect(retained.status).toBe(200);
    expect(retained.body).toEqual(initial.body);
  });

  it('GET /examples returns controlled error when upstream fetch fails', async () => {
    axios.mockRejectedValue(new Error('GitHub unavailable'));

    const res = await requestWithSupertest.get('/examples');

    expect(res.status).toEqual(502);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toEqual({
      error: 'Failed to load FEGA examples. GitHub unavailable'
    });
  });

  it('GET /cache returns the schema inventory and API cache details', async () => {
    clearApiCaches();
    server.biovalidator.clearSchemaCaches();
    olsCache.set('private-ols-key', {data: {}});
    enaTaxonomyCache.set('private-ena-key', {data: {}});
    identifiersCache.set('private-identifier-key', {data: {}});

    const res = await requestWithSupertest.get('/cache');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.schemas).toEqual({registered: [], validatorID: [], referenced: []});
    expect(res.body.api.entries).toEqual({
      total: 3,
      ols: 1,
      ena_taxonomy: 1,
      identifiers_org: 1
    });
    expect(JSON.stringify(res.body)).not.toContain('private-ols-key');
    expect(JSON.stringify(res.body)).not.toContain('private-ena-key');
    expect(JSON.stringify(res.body)).not.toContain('private-identifier-key');
    for (const provider of Object.values(res.body.api.providers)) {
      expect(provider).toEqual(expect.objectContaining({
        ttl_seconds: 21600,
        entries: 1,
        last_updated_at: expect.any(String)
      }));
    }
    clearApiCaches();
  });

  it('GET /cache reports a compiled top-level validator after validation', async () => {

    let inputSchema = JSON.parse(fs.readFileSync("examples/schemas/biosamples-schema.json", "utf-8"));
    let inputData = JSON.parse(fs.readFileSync("examples/objects/faang-organism-sample.json", "utf-8"));

    let res = await requestWithSupertest.post('/validate')
        .send({
          "schema": inputSchema,
          "data": inputData
        });

    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toEqual([])


    res = await requestWithSupertest.get('/cache');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.schemas).toEqual({
      registered: [],
      validatorID: ['test/biosamples/schema'],
      referenced: []
    });
  });

  it('GET /cache reports empty transient schema caches after clearing', async () => {
    let res = await requestWithSupertest.delete('/cache');
    expect(res.status).toEqual(200);

    res = await requestWithSupertest.get('/cache');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.schemas).toEqual({registered: [], validatorID: [], referenced: []});
  });

  it('disables both cache routes without disabling health when configured false', async () => {
    const disabledServer = new BioValidatorServer("3028", "", {
      environment: {BIOVALIDATOR_CACHE_ENDPOINT_ENABLED: " FALSE "}
    });
    disabledServer._configureServer()._configureEndpoints();
    const disabledRequest = supertest(disabledServer.app);

    await disabledRequest.get('/cache').expect(404);
    await disabledRequest.delete('/cache').expect(404);
    await disabledRequest.get('/health').expect(200);
    expect(isCacheEndpointEnabled({})).toBe(true);
    expect(isCacheEndpointEnabled({BIOVALIDATOR_CACHE_ENDPOINT_ENABLED: "true"})).toBe(true);
  });

  it('GET /health returns process, deployment, validation, and cache metrics', async () => {
    const originalDeployedAt = process.env.BIOVALIDATOR_DEPLOYED_AT;
    const originalRevision = process.env.BIOVALIDATOR_REVISION;
    process.env.BIOVALIDATOR_DEPLOYED_AT = '2026-07-03T12:00:00Z';
    process.env.BIOVALIDATOR_REVISION = 'abc123';
    const healthServer = new BioValidatorServer("3022", "");
    healthServer._configureServer()._configureEndpoints();
    const healthRequest = supertest(healthServer.app);

    clearApiCaches();
    healthServer.biovalidator.clearSchemaCaches();
    healthServer.biovalidator.ajvContexts['2019'].validatorCache.set('health-compiled', Promise.resolve(() => true));
    healthServer.biovalidator.ajvContexts['2020'].referencedSchemaCache.set('health-referenced', {});
    olsCache.set('health-ols', {data: {}});
    enaTaxonomyCache.set('health-ena', {data: {}});
    identifiersCache.set('health-identifiers', {data: {}});
    try {
      const res = await healthRequest.get('/health');

      expect(res.status).toEqual(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        version: '2.2.2',
        deployed_at: '2026-07-03T12:00:00Z',
        revision: 'abc123',
        dependency_versions: {
          node: process.versions.node,
          npm: expect.any(String)
        },
        validation: {
          requests: {total: 0, successful: 0, failed: 0, in_flight: 0},
          results: {valid: 0, invalid: 0}
        },
        cache: {
          schemas: {
            ttl_seconds: 21600,
            entries: {total: 2, compiled: 1, referenced: 1}
          },
          api: {
            entries: {total: 3, ols: 1, ena_taxonomy: 1, identifiers_org: 1}
          }
        }
      });
      expect(Number.isFinite(res.body.uptime_seconds)).toBe(true);
      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
      expect(new Date(res.body.process_started_at).toISOString()).toBe(res.body.process_started_at);
      expect(res.body.dependency_versions.node).not.toMatch(/^v/);
      expect(res.body.dependency_versions.npm).not.toMatch(/^v/);

      for (const cache of [
        res.body.cache.schemas,
        ...Object.values(res.body.cache.api.providers)
      ]) {
        expect(cache).toEqual(expect.objectContaining({
          last_updated_at: expect.any(String),
          last_cleared_at: expect.any(String),
          oldest_entry_at: expect.any(String),
          newest_entry_at: expect.any(String),
          next_expiration_at: expect.any(String)
        }));
      }
    } finally {
      if (originalDeployedAt === undefined) delete process.env.BIOVALIDATOR_DEPLOYED_AT;
      else process.env.BIOVALIDATOR_DEPLOYED_AT = originalDeployedAt;
      if (originalRevision === undefined) delete process.env.BIOVALIDATOR_REVISION;
      else process.env.BIOVALIDATOR_REVISION = originalRevision;
      clearApiCaches();
      healthServer.biovalidator.clearSchemaCaches();
    }
  });

  it('GET /health falls back to process startup and the local Git revision', async () => {
    const originalDeployedAt = process.env.BIOVALIDATOR_DEPLOYED_AT;
    const originalRevision = process.env.BIOVALIDATOR_REVISION;
    delete process.env.BIOVALIDATOR_DEPLOYED_AT;
    delete process.env.BIOVALIDATOR_REVISION;

    try {
      const localServer = new BioValidatorServer("3027", "");
      localServer._configureServer()._configureEndpoints();
      const res = await supertest(localServer.app).get('/health');
      expect(res.status).toEqual(200);
      expect(res.body.deployed_at).toBe(res.body.process_started_at);
      const currentRevision = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8'
      }).trim();
      expect(res.body.revision).toBe(currentRevision);
    } finally {
      if (originalDeployedAt !== undefined) process.env.BIOVALIDATOR_DEPLOYED_AT = originalDeployedAt;
      if (originalRevision !== undefined) process.env.BIOVALIDATOR_REVISION = originalRevision;
    }
  });

  it('deployment metadata tolerates an installation without Git metadata', () => {
    const processStartedAt = '2026-07-03T12:00:00.000Z';

    expect(resolveDeploymentMetadata(processStartedAt, {}, '/path/that/does/not/exist')).toEqual({
      deployedAt: processStartedAt,
      revision: null
    });
  });

  it('normalizes runtime dependency versions', () => {
    const executeFileSync = jest.fn().mockReturnValue('v10.8.2\n');

    expect(resolveDependencyVersions(executeFileSync)).toEqual({
      node: process.versions.node.replace(/^v/, ''),
      npm: '10.8.2'
    });
    expect(executeFileSync).toHaveBeenCalledWith('npm', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  });

  it('reports a null npm version when npm is unavailable', () => {
    const executeFileSync = jest.fn(() => {
      throw new Error('npm not found');
    });

    expect(resolveDependencyVersions(executeFileSync)).toEqual({
      node: process.versions.node.replace(/^v/, ''),
      npm: null
    });
  });

  it('tracks successful valid/invalid validations and malformed or failed requests separately', async () => {
    const metricsServer = new BioValidatorServer("3023", "");
    metricsServer._configureServer()._configureEndpoints();
    const metricsRequest = supertest(metricsServer.app);

    await metricsRequest.post('/validate').send({
      schema: {$id: 'health-valid', type: 'object'},
      data: {}
    }).expect(200);
    await metricsRequest.post('/validate').send({
      schema: {$id: 'health-invalid', type: 'object', required: ['name']},
      data: {}
    }).expect(200);
    await metricsRequest.post('/validate')
        .set('Content-Type', 'application/json')
        .send('{"schema":')
        .expect(400);

    metricsServer.biovalidator.validate = jest.fn().mockRejectedValue(new Error('validation failed'));
    await metricsRequest.post('/validate').send({schema: {type: 'object'}, data: {}}).expect(500);

    const health = await metricsRequest.get('/health');
    expect(health.body.validation).toEqual({
      requests: {total: 4, successful: 2, failed: 2, in_flight: 0},
      results: {valid: 1, invalid: 1}
    });
  });

  it('reports an active validation as in flight until it completes', async () => {
    const metricsServer = new BioValidatorServer("3024", "");
    metricsServer._configureServer()._configureEndpoints();
    const metricsRequest = supertest(metricsServer.app);
    let resolveValidation;
    metricsServer.biovalidator.validate = jest.fn(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    const pendingValidation = metricsRequest.post('/validate')
        .send({schema: {type: 'object'}, data: {}})
        .then((response) => response);
    while (!resolveValidation) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const during = await metricsRequest.get('/health');
    expect(during.body.validation.requests).toEqual({
      total: 1,
      successful: 0,
      failed: 0,
      in_flight: 1
    });

    resolveValidation([]);
    await pendingValidation;
    const after = await metricsRequest.get('/health');
    expect(after.body.validation).toEqual({
      requests: {total: 1, successful: 1, failed: 0, in_flight: 0},
      results: {valid: 1, invalid: 0}
    });
  });

  it('counts an aborted validation request as failed exactly once', () => {
    const metricsServer = new BioValidatorServer("3025", "");
    const response = new EventEmitter();
    response.statusCode = 200;
    response.writableEnded = false;
    response.locals = {};

    metricsServer._trackValidationRequest(
        {method: 'POST', path: '/validate'},
        response,
        jest.fn()
    );
    response.emit('close');
    response.emit('finish');

    expect(metricsServer.validationMetrics).toEqual({
      requests: {total: 1, successful: 0, failed: 1, in_flight: 0},
      results: {valid: 0, invalid: 0}
    });
  });

  it('DELETE /cache supports isolated api and schema scopes, all, and invalid scopes', async () => {
    const scopedServer = new BioValidatorServer("3026", "test/resources/schema_registry/valid");
    scopedServer._configureServer()._configureEndpoints();
    const scopedRequest = supertest(scopedServer.app);
    const schemaCache = scopedServer.biovalidator.ajvContexts['2019'].validatorCache;

    clearApiCaches();
    schemaCache.set('scope-schema', Promise.resolve(() => true));
    olsCache.set('scope-api', {data: {}});

    let res = await scopedRequest.delete('/cache?scope=api');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({message: 'Cache cleared successfully', scope: 'api', cleared: ['api']});
    expect(schemaCache.has('scope-schema')).toBe(true);
    expect(olsCache.keys()).toEqual([]);

    olsCache.set('scope-api', {data: {}});
    res = await scopedRequest.delete('/cache?scope=schemas');
    expect(res.body).toEqual({message: 'Cache cleared successfully', scope: 'schemas', cleared: ['schemas']});
    expect(schemaCache.keys()).toEqual([]);
    expect(olsCache.has('scope-api')).toBe(true);
    expect(scopedServer.biovalidator.getSchemaInventory().registered).toEqual([
      'https://example.org/local/draft2019.json',
      'https://example.org/local/draft2020.json'
    ]);

    schemaCache.set('scope-schema', Promise.resolve(() => true));
    res = await scopedRequest.delete('/cache');
    expect(res.body).toEqual({message: 'Cache cleared successfully', scope: 'all', cleared: ['schemas', 'api']});
    expect(schemaCache.keys()).toEqual([]);
    expect(olsCache.keys()).toEqual([]);

    schemaCache.set('scope-schema', Promise.resolve(() => true));
    olsCache.set('scope-api', {data: {}});
    res = await scopedRequest.delete('/cache?scope=unknown');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({error: 'Invalid cache scope. Expected one of: all, schemas, api.'});
    expect(schemaCache.has('scope-schema')).toBe(true);
    expect(olsCache.has('scope-api')).toBe(true);

    res = await scopedRequest.delete('/cache?scope=');
    expect(res.status).toBe(400);

    clearApiCaches();
    scopedServer.biovalidator.clearSchemaCaches();
  });

});

describe('biovalidator server shutdown', () => {
  let removePidSpy;

  beforeEach(() => {
    removePidSpy = jest.spyOn(npid, 'remove').mockImplementation(() => {});
  });

  afterEach(() => {
    removePidSpy.mockRestore();
  });

  it('registers SIGTERM, SIGINT, and SIGUSR1 as server-only shutdown hooks', () => {
    const removeOnExit = jest.fn();
    const createPidSpy = jest.spyOn(npid, 'create').mockReturnValue({removeOnExit});
    const onceSpy = jest.spyOn(process, 'once').mockImplementation(() => process);
    const hookServer = new BioValidatorServer("3029", "");

    try {
      hookServer._registerHooks();

      expect(createPidSpy).toHaveBeenCalledWith(hookServer.pidPath);
      expect(removeOnExit).toHaveBeenCalled();
      expect(onceSpy.mock.calls.map(([signal]) => signal)).toEqual([...SHUTDOWN_SIGNALS]);
    } finally {
      hookServer._removeShutdownHooks();
      onceSpy.mockRestore();
      createPidSpy.mockRestore();
    }
  });

  it('stops HTTP acceptance, closes workers, removes the PID file, and exits successfully once', async () => {
    const processExit = jest.fn();
    const validationPool = {close: jest.fn().mockResolvedValue()};
    const shutdownServer = new BioValidatorServer("3030", "", {
      validationPool,
      processExit
    });
    let finishHttpClose;
    shutdownServer.expressServer = {
      close: jest.fn((callback) => {
        finishHttpClose = callback;
      })
    };

    const firstShutdown = shutdownServer.shutdown("SIGTERM");
    const repeatedShutdown = shutdownServer.shutdown("SIGINT");

    expect(repeatedShutdown).toBe(firstShutdown);
    expect(shutdownServer.expressServer.close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(validationPool.close).toHaveBeenCalledTimes(1);

    finishHttpClose();
    await expect(firstShutdown).resolves.toBe(0);
    expect(removePidSpy).toHaveBeenCalledWith(shutdownServer.pidPath);
    expect(processExit).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);
  });

  it('forces a nonzero exit after the bounded shutdown timeout', async () => {
    const processExit = jest.fn();
    const validationPool = {close: jest.fn().mockResolvedValue()};
    const shutdownServer = new BioValidatorServer("3031", "", {
      validationPool,
      processExit,
      shutdownTimeoutMs: 5
    });
    shutdownServer.expressServer = {close: jest.fn()};

    const shutdown = shutdownServer.shutdown("SIGTERM");

    await expect(shutdown).resolves.toBe(1);
    expect(validationPool.close).toHaveBeenCalledTimes(1);
    expect(removePidSpy).toHaveBeenCalledWith(shutdownServer.pidPath);
    expect(processExit).toHaveBeenCalledWith(1);
  });
});
