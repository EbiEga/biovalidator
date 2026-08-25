describe('cache configuration', () => {
  const originalCacheTtl = process.env.BIOVALIDATOR_CACHE_TTL_SECONDS;

  afterEach(() => {
    if (originalCacheTtl === undefined) {
      delete process.env.BIOVALIDATOR_CACHE_TTL_SECONDS;
    } else {
      process.env.BIOVALIDATOR_CACHE_TTL_SECONDS = originalCacheTtl;
    }
    jest.resetModules();
  });

  function loadConfig(value) {
    if (value === undefined) {
      delete process.env.BIOVALIDATOR_CACHE_TTL_SECONDS;
    } else {
      process.env.BIOVALIDATOR_CACHE_TTL_SECONDS = value;
    }
    jest.resetModules();
    return require('../src/utils/cache-config');
  }

  test('defaults to six hours', () => {
    const config = loadConfig(undefined);
    expect(config.CACHE_TTL_SECONDS).toBe(21600);
    expect(config.CACHE_CHECK_PERIOD_SECONDS).toBe(3600);
  });

  test.each([
    ['one hour', '3600', 3600],
    ['one day', '86400', 86400]
  ])('accepts %s as a positive whole number of seconds', (name, value, expected) => {
    const config = loadConfig(value);
    expect(config.CACHE_TTL_SECONDS).toBe(expected);
    expect(config.CACHE_CHECK_PERIOD_SECONDS).toBe(3600);
  });

  test('reduces the cleanup period for TTLs shorter than one hour', () => {
    const config = loadConfig('60');
    expect(config.CACHE_TTL_SECONDS).toBe(60);
    expect(config.CACHE_CHECK_PERIOD_SECONDS).toBe(60);
  });

  test.each(['', '0', '-1', '1.5', '60s', ' 3600', '3600 '])(
      'rejects invalid value %j',
      (value) => {
        expect(() => loadConfig(value)).toThrow(
            'Invalid BIOVALIDATOR_CACHE_TTL_SECONDS: expected a positive whole number of seconds.'
        );
      }
  );

  test('rejects values that cannot be represented safely', () => {
    expect(() => loadConfig(String(Number.MAX_SAFE_INTEGER))).toThrow(
        'Invalid BIOVALIDATOR_CACHE_TTL_SECONDS: value is too large to represent safely.'
    );
  });

  test('applies the configured TTL to schema and validation API caches', () => {
    process.env.BIOVALIDATOR_CACHE_TTL_SECONDS = '3600';
    jest.resetModules();

    const BioValidator = require('../src/core/biovalidator-core');
    const {SecureHttpClient} = require('../src/utils/secure-http-client');
    const validator = new BioValidator('');

    expect(validator.getSchemaCacheDetails().ttl_seconds).toBe(3600);
    expect(validator.ajvContexts['2019'].validatorCache.options.stdTTL).toBe(3600);
    expect(validator.ajvContexts['2020'].referencedSchemaCache.options.stdTTL).toBe(3600);
    expect(validator.httpClient.apiCache.ttlMs).toBe(3600 * 1000);
    expect(Object.values(validator.httpClient.apiSnapshot().providers).map((provider) => provider.ttl_seconds))
        .toEqual([3600, 3600, 3600, 3600]);
    expect(new SecureHttpClient().apiCache.ttlMs).toBe(3600 * 1000);
  });
});
