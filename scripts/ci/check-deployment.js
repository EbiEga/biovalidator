#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const yaml = require('js-yaml');
function checkDeployment(documents, {production = false, routing = false, expectedImage} = {}) {
    const deployment = documents.find(doc => doc?.kind === 'Deployment');
    assert(deployment, 'Deployment is required');
    const pod = deployment.spec.template.spec;
    const labels = deployment.spec.template.metadata.labels;
    const matches = selector => selector && Object.keys(selector).length > 0 &&
        Object.entries(selector).every(([key, value]) => labels[key] === value);
    assert(matches(deployment.spec.selector.matchLabels), 'Deployment selector must match pod labels');
    assert.equal(pod.automountServiceAccountToken, false, 'Disable API token mounting');
    assert.equal(pod.securityContext.runAsNonRoot, true, 'Require a non-root identity');
    assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault', 'Require seccomp');
    for (const container of pod.containers) {
        // This policy describes this application's explicit repository + tag/digest.
        assert(/^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/.test(container.image), 'Require a valid tagged image or digest');
        if (expectedImage) assert.equal(container.image, expectedImage, 'Rendered image must match the verified image');
        assert.equal(container.securityContext.allowPrivilegeEscalation, false, 'Disable privilege escalation');
        assert.equal(container.securityContext.readOnlyRootFilesystem, true, 'Require read-only root');
        assert(container.securityContext.capabilities.drop.includes('ALL'), 'Drop capabilities');
        assert(container.resources.limits.memory && container.resources.limits.cpu && container.resources.limits['ephemeral-storage'], 'Require resource limits');
        const env = Object.fromEntries((container.env || []).map(entry => [entry.name, entry.value]));
        const base = (env.BIOVALIDATOR_BASE_URL || '').replace(/\/$/, '');
        const port = Number(env.BIOVALIDATOR_PORT || 3020);
        const resolvePort = value => typeof value === 'number' ? value :
            container.ports?.find(entry => entry.name === value)?.containerPort;
        for (const [probe, endpoint] of [['livenessProbe', 'live'], ['readinessProbe', 'ready']]) {
            assert.equal(container[probe]?.httpGet?.path, `${base}/${endpoint}`, `Use the configured ${endpoint} path`);
            assert.equal(resolvePort(container[probe]?.httpGet?.port), port, 'Probe must reach the application port');
        }
        if (routing || production) {
            const service = documents.find(doc => doc?.kind === 'Service');
            const ingress = documents.find(doc => doc?.kind === 'Ingress');
            assert(service && ingress, 'Service and Ingress are required for routing checks');
            assert(matches(service.spec.selector), 'Service selector must match pod labels');
            assert.equal(service.metadata.namespace, deployment.metadata.namespace, 'Service namespace must match Deployment');
            assert.equal(ingress.metadata.namespace, service.metadata.namespace, 'Ingress namespace must match Service');
            const routes = ingress.spec.rules.flatMap(rule => rule.http.paths);
            assert(routes.length > 0, 'Ingress must contain a route');
            for (const route of routes) {
                assert.equal(route.path, base || '/', 'Ingress must use the application base path');
                assert.equal(route.backend.service.name, service.metadata.name, 'Ingress must route to the application Service');
                const backendPort = route.backend.service.port;
                const servicePort = service.spec.ports.find(entry => backendPort.name ? entry.name === backendPort.name : entry.port === backendPort.number);
                assert(servicePort, 'Ingress port must exist on the Service');
                assert.equal(resolvePort(servicePort.targetPort ?? servicePort.port), port, 'Service must reach the application port');
            }
        }
    }
    assert(pod.volumes.every(volume => !volume.hostPath && (!volume.emptyDir || volume.emptyDir.sizeLimit)), 'Bound temporary storage; forbid host mounts');
    if (production) {
        const ingress = documents.find(doc => doc?.kind === 'Ingress');
        assert(ingress?.spec.tls?.[0]?.secretName, 'Require TLS');
        assert(ingress.spec.tls[0].hosts.includes(ingress.spec.rules[0].host), 'TLS host must match route');
        assert.equal(ingress.metadata.annotations['nginx.ingress.kubernetes.io/force-ssl-redirect'], 'true', 'Require HTTPS redirect');
        const network = documents.find(doc => doc?.kind === 'NetworkPolicy');
        assert(network?.spec.policyTypes.includes('Ingress') && network.spec.policyTypes.includes('Egress'), 'Require ingress and egress isolation');
        assert(network.spec.ingress.every(rule => rule.from?.length && rule.from.every(peer => peer.namespaceSelector && peer.podSelector)), 'Scope ingress to selected gateway pods');
        assert(network.spec.egress.every(rule => rule.to?.length && rule.ports?.length), 'Scope egress destinations and ports');
        assert(network.spec.egress.every(rule => rule.to.every(peer => !peer.ipBlock || !peer.ipBlock.cidr.endsWith('/0'))), 'Forbid unrestricted egress ranges');
        assert(pod.containers[0].env.some(entry => entry.name === 'BIOVALIDATOR_TRUST_PROXY' && entry.value), 'Require explicit trusted proxies');
    }
}
if (require.main === module) {
    try {
        const file = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'k8s/deployment.yaml';
        const documents = yaml.loadAll(fs.readFileSync(file, 'utf8'));
        if (process.argv.includes('--with-routing')) {
            for (const [kind, file] of [['Service', 'k8s/service.yaml'], ['Ingress', 'k8s/ingress.yaml']]) {
                if (!documents.some(doc => doc?.kind === kind)) documents.push(yaml.load(fs.readFileSync(file, 'utf8')));
            }
        }
        checkDeployment(documents, {production: process.argv.includes('--production'),
            routing: process.argv.includes('--with-routing'), expectedImage: process.env.EXPECTED_IMAGE});
        console.log('Deployment security policy passed.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {checkDeployment};
