#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const yaml = require('js-yaml');
const {parsePositiveInteger} = require('../../src/utils/security-config');

function required(environment, name) {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`Set ${name} using values verified by your Kubernetes administrator.`);
    return value;
}
function cidrs(value, name) {
    return value.split(',').map(entry => {
        const [address, prefix, extra] = entry.trim().split('/');
        const family = net.isIP(address);
        const bits = family === 4 ? 32 : 128;
        if (!family || extra !== undefined || !/^\d+$/.test(prefix || '') || Number(prefix) < 1 || Number(prefix) > bits) {
            throw new Error(`${name} must contain explicit IPv4/IPv6 CIDRs; unrestricted /0 ranges are not allowed.`);
        }
        return `${address}/${Number(prefix)}`;
    });
}
function renderProduction(environment = process.env) {
    const host = required(environment, 'PUBLIC_HOST');
    if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.split('.').some(label => !label || label.length > 63)) {
        throw new Error('PUBLIC_HOST must be a DNS hostname without a scheme or path.');
    }
    const namespace = required(environment, 'DEPLOY_NAMESPACE');
    const ingressNamespace = required(environment, 'INGRESS_NAMESPACE');
    const tlsSecret = required(environment, 'TLS_SECRET');
    const ingressClass = required(environment, 'INGRESS_CLASS');
    for (const [name, value] of Object.entries({namespace, ingressNamespace, tlsSecret, ingressClass})) {
        if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) throw new Error(`Invalid Kubernetes ${name}.`);
    }
    const label = required(environment, 'INGRESS_POD_LABEL');
    const separator = label.indexOf('=');
    if (separator < 1 || separator === label.length - 1) throw new Error('INGRESS_POD_LABEL must be key=value.');
    const labelKey = label.slice(0, separator), labelValue = label.slice(separator + 1);
    const trusted = cidrs(required(environment, 'TRUST_PROXY_CIDRS'), 'TRUST_PROXY_CIDRS');
    const destinations = cidrs(required(environment, 'EGRESS_CIDRS'), 'EGRESS_CIDRS');
    const load = file => yaml.load(fs.readFileSync(path.join(__dirname, '../../k8s', file), 'utf8'));
    const deployment = load('deployment.yaml'), service = load('service.yaml'), ingress = load('ingress.yaml');
    const container = deployment.spec.template.spec.containers[0];
    if (environment.DEPLOY_IMAGE) container.image = environment.DEPLOY_IMAGE;
    container.env.push({name: 'BIOVALIDATOR_TRUST_PROXY', value: trusted.join(',')});
    ingress.spec.ingressClassName = ingressClass;
    ingress.spec.rules[0].host = host;
    ingress.spec.tls = [{hosts: [host], secretName: tlsSecret}];
    // This profile targets a controller supporting the nginx.ingress.kubernetes.io annotations.
    ingress.metadata.annotations = {
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
        'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true',
        'nginx.ingress.kubernetes.io/limit-rps': String(parsePositiveInteger(environment, 'INGRESS_RATE_RPS', 10)),
        'nginx.ingress.kubernetes.io/limit-connections': String(parsePositiveInteger(environment, 'INGRESS_CONNECTIONS', 20))
    };
    const network = {
        apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: {name: 'biovalidator'},
        spec: {podSelector: {matchLabels: {app: 'biovalidator'}}, policyTypes: ['Ingress', 'Egress'],
            ingress: [{from: [{namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': ingressNamespace}},
                podSelector: {matchLabels: {[labelKey]: labelValue}}}], ports: [{protocol: 'TCP', port: 3020}]}],
            egress: [
                {to: [{namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'kube-system'}},
                    podSelector: {matchLabels: {'k8s-app': 'kube-dns'}}}],
                ports: [{protocol: 'UDP', port: 53}, {protocol: 'TCP', port: 53}]},
                {to: destinations.map(cidr => ({ipBlock: {cidr}})), ports: [{protocol: 'TCP', port: 443}]}
            ]}
    };
    // Deliberately no RoleBinding: the administrator chooses who can read value-containing logs.
    const logRole = {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: {name: 'biovalidator-log-reader'},
        rules: [{apiGroups: [''], resources: ['pods'], verbs: ['get', 'list']},
            {apiGroups: [''], resources: ['pods/log'], verbs: ['get']}]};
    const documents = [deployment, service, ingress, network, logRole];
    for (const document of documents) document.metadata.namespace = namespace;
    return documents;
}
if (require.main === module) {
    try { process.stdout.write(renderProduction().map(doc => yaml.dump(doc, {noRefs: true})).join('---\n')); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {renderProduction, cidrs};
