const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');
const yaml = require('js-yaml');
const {renderProduction} = require('../scripts/ci/render-production');
const {checkDeployment} = require('../scripts/ci/check-deployment');
const environment = {
    PUBLIC_HOST: 'validator.example.org', DEPLOY_NAMESPACE: 'validation', TLS_SECRET: 'validator-tls',
    INGRESS_NAMESPACE: 'gateway', INGRESS_CLASS: 'nginx', INGRESS_POD_LABEL: 'app=controller',
    TRUST_PROXY_CIDRS: '10.30.0.0/24', EGRESS_CIDRS: '203.0.113.10/32,2001:db8::1/128'
};

test('base deployment enforces restricted pod settings with a lightweight probe', () => {
    const deployment = yaml.load(fs.readFileSync('k8s/deployment.yaml', 'utf8'));
    expect(() => checkDeployment([deployment])).not.toThrow();
});

test('production output binds TLS, ingress identity, egress destinations and proxy trust', () => {
    const documents = renderProduction(environment);
    expect(() => checkDeployment(documents, {production: true})).not.toThrow();
    const ingress = documents.find(doc => doc.kind === 'Ingress');
    expect(ingress.spec.tls).toEqual([{hosts: ['validator.example.org'], secretName: 'validator-tls'}]);
    const network = documents.find(doc => doc.kind === 'NetworkPolicy');
    expect(network.spec.ingress[0].from[0]).toEqual({
        namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'gateway'}},
        podSelector: {matchLabels: {app: 'controller'}}
    });
    expect(network.spec.egress[1].to).toEqual([{ipBlock: {cidr: '203.0.113.10/32'}}, {ipBlock: {cidr: '2001:db8::1/128'}}]);
    expect(documents.every(doc => doc.metadata.namespace === 'validation')).toBe(true);
    expect(documents.some(doc => doc.kind === 'RoleBinding')).toBe(false);
    const role = documents.find(doc => doc.kind === 'Role');
    expect(role.rules.find(rule => rule.resources.includes('pods/log')).verbs).toEqual(['get']);
});

test.each(Object.keys(environment))('production rendering requires administrator input: %s', name => {
    expect(() => renderProduction({...environment, [name]: ''})).toThrow(name);
});

test.each(['0.0.0.0/0', '::/0', '10.0.0.0/99', 'https://example.org', '10.0.0.0/24/extra'])('rejects unsafe or malformed ranges: %s', value => {
    expect(() => renderProduction({...environment, TRUST_PROXY_CIDRS: value})).toThrow('CIDRs');
    expect(() => renderProduction({...environment, EGRESS_CIDRS: value})).toThrow('CIDRs');
});

test.each([
    docs => { docs[0].spec.template.spec.automountServiceAccountToken = true; },
    docs => { docs[0].spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem = false; },
    docs => { docs[2].spec.tls = []; },
    docs => { docs[3].spec.egress[1].to = [{ipBlock: {cidr: '0.0.0.0/0'}}]; }
])('deployment policy rejects a security regression', mutate => {
    const documents = renderProduction(environment);
    mutate(documents);
    expect(() => checkDeployment(documents, {production: true})).toThrow();
});

test('image scanner fails the release when the scanner reports findings', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biovalidator-scan-test-'));
    const executable = path.join(directory, 'docker');
    fs.writeFileSync(executable, '#!/bin/sh\ncase "$1" in\n create) echo scanner ;;\n inspect) echo "$SCANNER_RESULT" ;;\n *) exit 0 ;;\nesac\n', {mode: 0o700});
    try {
        for (const code of ['0', '1']) {
            const result = spawnSync('sh', ['scripts/ci/scan-container.sh'], {
                env: {...process.env, PATH: `${directory}:${process.env.PATH}`, SCANNER_RESULT: code}, encoding: 'utf8'
            });
            expect(result.status).toBe(code === '0' ? 0 : 1);
        }
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
