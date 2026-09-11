#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const yaml = require('js-yaml');
function checkDeployment(documents, {production = false} = {}) {
    const deployment = documents.find(doc => doc?.kind === 'Deployment');
    assert(deployment, 'Deployment is required');
    const pod = deployment.spec.template.spec;
    assert.equal(pod.automountServiceAccountToken, false, 'Disable API token mounting');
    assert.equal(pod.securityContext.runAsNonRoot, true, 'Require a non-root identity');
    assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault', 'Require seccomp');
    for (const container of pod.containers) {
        assert.equal(container.securityContext.allowPrivilegeEscalation, false, 'Disable privilege escalation');
        assert.equal(container.securityContext.readOnlyRootFilesystem, true, 'Require read-only root');
        assert(container.securityContext.capabilities.drop.includes('ALL'), 'Drop capabilities');
        assert(container.resources.limits.memory && container.resources.limits.cpu && container.resources.limits['ephemeral-storage'], 'Require resource limits');
        assert(container.livenessProbe.httpGet.path.endsWith('/live'), 'Use lightweight liveness');
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
        checkDeployment(yaml.loadAll(fs.readFileSync(process.argv[2] || 'k8s/deployment.yaml', 'utf8')),
            {production: process.argv.includes('--production')});
        console.log('Deployment security policy passed.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {checkDeployment};
