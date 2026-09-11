const https = require('https');
const {createPublicLookup, isPublicAddress} = require('../src/utils/public-dns');
const {SecureHttpClient, parseAndValidateUrl} = require('../src/utils/secure-http-client');
const {loadSecurityConfig} = require('../src/utils/security-config');
const config = loadSecurityConfig({BIOVALIDATOR_REMOTE_REF_ALLOWLIST: 'https://schemas.example.org/trusted/'});
const lookup = (resolver, options = {all: true}) => new Promise((resolve, reject) => {
    createPublicLookup(resolver)('schemas.example.org', options, (error, addresses, family) => {
        if (error) reject(error); else resolve({addresses, family});
    });
});

test.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '4000::1'
])('rejects non-public address %s', address => {
    expect(isPublicAddress(address)).toBe(false);
});

test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permits public address %s', address => {
    expect(isPublicAddress(address)).toBe(true);
});

test('checks all DNS answers, including a private address in the other IP family', async () => {
    const resolver = (_host, _options, callback) => callback(null, [
        {address: '1.1.1.1', family: 4}, {address: '::1', family: 6}
    ]);
    await expect(lookup(resolver, {family: 4})).rejects.toMatchObject({code: 'OUTBOUND_ADDRESS_DENIED'});
});

test('returns the checked answers without a second DNS resolution', async () => {
    let calls = 0;
    const resolver = jest.fn((_host, _options, callback) => callback(null, ++calls === 1
        ? [{address: '1.1.1.1', family: 4}]
        : [{address: '127.0.0.1', family: 4}]));
    await expect(lookup(resolver)).resolves.toEqual({addresses: [{address: '1.1.1.1', family: 4}], family: undefined});
    expect(resolver).toHaveBeenCalledTimes(1);
    await expect(lookup(resolver)).rejects.toMatchObject({code: 'OUTBOUND_ADDRESS_DENIED'});
});

test('supports the single-address Node lookup contract', async () => {
    const resolver = (_host, _options, callback) => callback(null, [{address: '1.1.1.1', family: 4}]);
    await expect(lookup(resolver, {family: 4})).resolves.toEqual({addresses: '1.1.1.1', family: 4});
});

test('preserves DNS failures instead of turning them into a validation verdict', async () => {
    const failure = Object.assign(new Error('DNS unavailable'), {code: 'ENOTFOUND'});
    await expect(lookup((_host, _options, callback) => callback(failure))).rejects.toBe(failure);
});

test.each([
    'https://schemas.example.org.evil.test/trusted/schema.json',
    'https://schemas.example.org@evil.test/trusted/schema.json',
    'https://evil.test@schemas.example.org/trusted/schema.json',
    'https://schemas.example.org:8443/trusted/schema.json',
    'https://schemas.example.org/trusted/../private.json',
    'https://schemas.example.org/trusted/%2e%2e/private.json',
    'https://schemas.example.org/trusted/%2f..%2fprivate.json',
    'https://schemas.example.org/trusted/%5c..%5cprivate.json',
    'https://schemas.example.org/trusted-other/schema.json',
    'https://[::1]/trusted/schema.json',
    'https://2130706433/trusted/schema.json',
    'https://0x7f000001/trusted/schema.json'
])('rejects authority or path bypass before invoking the adapter: %s', async url => {
    const adapter = jest.fn();
    const client = new SecureHttpClient({config, adapter});
    await expect(client.getJson(url)).rejects.toBeDefined();
    expect(adapter).not.toHaveBeenCalled();
});

test.each(['https://[::1]/', 'https://127.0.0.1/', 'https://0x7f000001/'])('rejects IP-literal allowlist configuration: %s', url => {
    expect(() => loadSecurityConfig({BIOVALIDATOR_REMOTE_REF_ALLOWLIST: url})).toThrow('hostname');
});

test('reconstructing a URL keeps a double-slash pathname on the configured host', () => {
    const unrestrictedPath = loadSecurityConfig({BIOVALIDATOR_REMOTE_REF_ALLOWLIST: 'https://schemas.example.org/'});
    const parsed = parseAndValidateUrl('https://schemas.example.org//evil.test/schema.json', 'remoteSchema', unrestrictedPath);
    expect(parsed.origin).toBe('https://schemas.example.org');
    expect(parsed.pathname).toBe('//evil.test/schema.json');
});

test('real Axios rejects private DNS even when environment proxies are configured', async () => {
    const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
    const previous = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
    process.env.HTTPS_PROXY = process.env.https_proxy = 'http://127.0.0.1:1';
    process.env.NO_PROXY = process.env.no_proxy = '';
    const resolver = jest.fn((_hostname, _options, callback) => callback(null, [{address: '127.0.0.1', family: 4}]));
    const client = new SecureHttpClient({config, resolveHostname: resolver});
    try {
        await expect(client.getJson('https://schemas.example.org/trusted/schema.json'))
            .rejects.toMatchObject({code: 'OUTBOUND_ADDRESS_DENIED', status: 422});
        expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
        client.httpsAgent.destroy();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

test('request uses a checked HTTPS agent with certificate verification and no proxy or redirects', async () => {
    const adapter = jest.fn(async () => ({status: 200, data: '{}'}));
    const client = new SecureHttpClient({config, adapter});
    await client.getJson('https://schemas.example.org/trusted/schema.json');
    const options = adapter.mock.calls[0][0];
    expect(options).toMatchObject({proxy: false, maxRedirects: 0});
    expect(options.httpsAgent).toBeInstanceOf(https.Agent);
    expect(options.httpsAgent.options.rejectUnauthorized).toBe(true);
    expect(options.httpsAgent.options.proxyEnv).toEqual({});
    expect(typeof options.httpsAgent.options.lookup).toBe('function');
});
