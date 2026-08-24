const GraphRestriction = require('../src/keywords/graphRestriction');
const IsValidTaxonomy = require('../src/keywords/isvalidtaxonomy');
const IsValidTerm = require('../src/keywords/isvalidterm');
const IsValidIdentifier = require('../src/keywords/isvalididentifier');
const SecureHttpClient = require('../src/utils/secure-http-client').SecureHttpClient;
const WeightedTtlCache = require('../src/utils/weighted-ttl-cache');
const axios = require('axios');
const {docForTerm, olsResponse} = require('./olsTestUtils');

jest.mock('axios');

describe('central API cache for asynchronous keyword checks', () => {
  beforeEach(() => {
    axios.mockReset();
  });

  test('reuses OLS responses across keyword checks and reports provider metrics', async () => {
    const httpClient = new SecureHttpClient({adapter: axios});
    const term = 'http://purl.obolibrary.org/obo/UBERON_0002107';
    axios.mockResolvedValue(olsResponse([docForTerm(term)]));

    const validator = new IsValidTerm(null, undefined, {httpClient});
    const fn = validator.generateKeywordFunction();
    await fn(true, term);
    await fn(true, term);

    expect(axios).toHaveBeenCalledTimes(1);
    const snapshot = httpClient.apiSnapshot();
    expect(snapshot.entries).toMatchObject({total: 1, ols: 1});
    expect(snapshot.weight_bytes).toBeGreaterThan(0);
    expect(snapshot.providers.ols).toEqual(expect.objectContaining({
      ttl_seconds: 21600,
      entries: 1,
      last_updated_at: expect.any(String),
      oldest_entry_at: expect.any(String),
      newest_entry_at: expect.any(String),
      next_expiration_at: expect.any(String)
    }));
  });

  test('clears and repopulates OLS through the same central cache', async () => {
    const httpClient = new SecureHttpClient({adapter: axios});
    const term = 'http://purl.obolibrary.org/obo/UBERON_0002107';
    axios.mockResolvedValue(olsResponse([docForTerm(term)]));
    const fn = new IsValidTerm(null, undefined, {httpClient}).generateKeywordFunction();

    await fn(true, term);
    httpClient.clear('api');
    expect(httpClient.apiSnapshot().entries.total).toBe(0);
    await fn(true, term);

    expect(axios).toHaveBeenCalledTimes(2);
    expect(httpClient.apiSnapshot().providers.ols.last_cleared_at).toEqual(expect.any(String));
  });

  test('does not retain malformed OLS responses', async () => {
    const httpClient = new SecureHttpClient({adapter: axios});
    const term = 'BFO:0000040';
    axios.mockResolvedValue({status: 200, data: {response: {docs: [], numFound: 1, start: 0}}});
    const fn = new IsValidTerm(null, undefined, {httpClient}).generateKeywordFunction();

    await expect(fn(true, term)).rejects.toThrow();
    await expect(fn(true, term)).rejects.toThrow();
    expect(axios).toHaveBeenCalledTimes(2);
    expect(httpClient.apiSnapshot().entries.ols).toBe(0);
  });

  test('reuses valid ENA negative responses but does not retain malformed responses', async () => {
    const httpClient = new SecureHttpClient({adapter: axios});
    const fn = new IsValidTaxonomy(null, {httpClient}).generateKeywordFunction();
    axios.mockResolvedValue({status: 200, data: []});

    await expect(fn(true, 'Unknown organism')).rejects.toThrow();
    await expect(fn(true, 'Unknown organism')).rejects.toThrow();
    expect(axios).toHaveBeenCalledTimes(1);
    expect(httpClient.apiSnapshot().entries.ena_taxonomy).toBe(1);

    httpClient.clear('api');
    axios.mockResolvedValue({status: 200, data: [{unexpected: 'shape'}]});
    await expect(fn(true, 'Unknown organism')).rejects.toThrow();
    await expect(fn(true, 'Unknown organism')).rejects.toThrow();
    expect(axios).toHaveBeenCalledTimes(3);
    expect(httpClient.apiSnapshot().entries.ena_taxonomy).toBe(0);
  });

  test('reuses valid identifiers.org negative responses and rejects malformed responses without caching', async () => {
    const httpClient = new SecureHttpClient({adapter: axios});
    const fn = new IsValidIdentifier({httpClient}).validationFunction();
    axios.mockResolvedValue({status: 200, data: {payload: {resolvedResources: []}}});

    await expect(fn({prefixes: ['uniprot']}, 'uniprot:P12345')).rejects.toThrow();
    await expect(fn({prefixes: ['uniprot']}, 'uniprot:P12345')).rejects.toThrow();
    expect(axios).toHaveBeenCalledTimes(1);
    expect(httpClient.apiSnapshot().entries.identifiers_org).toBe(1);

    httpClient.clear('api');
    axios.mockResolvedValue({status: 200, data: {payload: {resolvedResources: [{}]}}});
    await expect(fn({prefixes: ['uniprot']}, 'uniprot:P12345')).rejects.toThrow();
    await expect(fn({prefixes: ['uniprot']}, 'uniprot:P12345')).rejects.toThrow();
    expect(axios).toHaveBeenCalledTimes(3);
    expect(httpClient.apiSnapshot().entries.identifiers_org).toBe(0);
  });

  test('shares one API cache across OLS, ENA, and identifiers.org providers', async () => {
    const httpClient = new SecureHttpClient({adapter: axios});
    axios.mockImplementation((config) => {
      const url = new URL(config.url);
      if (url.pathname.startsWith('/ena/taxonomy/')) {
        return Promise.resolve({status: 200, data: [{taxId: 9606, submittable: 'true'}]});
      }
      if (url.hostname === 'resolver.api.identifiers.org') {
        return Promise.resolve({status: 200, data: {payload: {resolvedResources: []}}});
      }
      return Promise.resolve(olsResponse([docForTerm('http://purl.obolibrary.org/obo/UBERON_0002107')]));
    });

    const ols = new IsValidTerm(null, undefined, {httpClient}).generateKeywordFunction();
    const taxonomy = new IsValidTaxonomy(null, {httpClient}).generateKeywordFunction();
    const identifiers = new IsValidIdentifier({httpClient}).validationFunction();
    await ols(true, 'http://purl.obolibrary.org/obo/UBERON_0002107');
    await taxonomy(true, 'Homo sapiens');
    await expect(identifiers({prefixes: ['uniprot']}, 'uniprot:P12345')).rejects.toThrow();

    expect(httpClient.apiSnapshot().entries).toEqual({
      total: 3,
      ols: 1,
      ena_taxonomy: 1,
      identifiers_org: 1,
      github_api: 0
    });
  });

  test('applies central API-cache eviction and expiration across providers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    const apiCache = new WeightedTtlCache({maxEntries: 1, maxWeight: 10_000, ttlMs: 60_000});
    const httpClient = new SecureHttpClient({adapter: axios, apiCache});
    axios.mockResolvedValue({status: 200, data: {cached: true}, headers: {}});

    try {
      await httpClient.getJson('https://www.ebi.ac.uk/ols4/api/search?q=eviction', {
        kind: 'ols', cache: true
      });
      await httpClient.getJson('https://www.ebi.ac.uk/ena/taxonomy/rest/any-name/eviction', {
        kind: 'ena', cache: true
      });
      expect(httpClient.apiSnapshot().entries).toEqual({
        total: 1,
        ols: 0,
        ena_taxonomy: 1,
        identifiers_org: 0,
        github_api: 0
      });
      expect(httpClient.apiSnapshot().providers.ena_taxonomy.ttl_seconds).toBe(60);

      jest.advanceTimersByTime(60_001);
      expect(httpClient.apiSnapshot().entries.total).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
