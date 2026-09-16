#!/usr/bin/env node
'use strict';

// Rehearse the two repository-owned jobs, not GitLab's scheduler or templates.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {randomUUID} = require('crypto');
const {spawn, execFileSync} = require('child_process');
const yaml = require('js-yaml');

function onlyKeys(object, allowed, context) {
    assert(object && typeof object === 'object' && !Array.isArray(object), `${context} must be a mapping`);
    for (const key of Object.keys(object)) {
        assert(allowed.includes(key), `Unsupported ${context}.${key}; update the rehearsal before using it`);
    }
}

function pinnedImage(value) {
    assert(typeof value === 'string' && /^[\w./:-]+:[\w.-]+@sha256:[a-f0-9]{64}$/.test(value),
        'CI images must have a readable tag and sha256 digest');
    return value;
}

function readConfig(source) {
    const config = yaml.load(source);
    onlyKeys(config, ['include', 'stages', 'variables', 'internal-tests', 'docker-build'], 'pipeline');
    assert.deepEqual(config.include, [
        {template: 'Jobs/SAST.gitlab-ci.yml'},
        {template: 'Jobs/Dependency-Scanning.gitlab-ci.yml'},
        {template: 'Jobs/Secret-Detection.gitlab-ci.yml'}
    ], 'Review template changes for effects on rehearsed jobs');
    assert.deepEqual(config.stages, ['test', 'build-containers']);
    onlyKeys(config.variables, ['CI_NODE_IMAGE'], 'pipeline.variables');
    const nodeImage = pinnedImage(config.variables.CI_NODE_IMAGE);
    const internal = config['internal-tests'];
    onlyKeys(internal, ['stage', 'image', 'script', 'rules'], 'internal-tests');
    assert.equal(internal.stage, 'test');
    assert.equal(internal.image, '$CI_NODE_IMAGE');
    assert.deepEqual(internal.script, ['sh scripts/ci/check-internal.sh']);
    const build = config['docker-build'];
    onlyKeys(build, ['stage', 'image', 'services', 'variables', 'before_script', 'script', 'artifacts', 'after_script', 'rules'], 'docker-build');
    assert.equal(build.stage, 'build-containers');
    const cliImage = pinnedImage(build.image);
    assert.deepEqual(build.before_script, ['sh scripts/ci/wait-docker.sh']);
    assert.deepEqual(build.script, ['sh scripts/ci/verify-image.sh', 'sh scripts/ci/publish-image.sh'],
        'Keep verification in the shared entrypoint, before publication');
    assert.deepEqual(build.after_script, ['docker logout dockerhub.ebi.ac.uk || true']);
    assert.deepEqual(build.artifacts, {paths: ['deployment-immutable.yaml']});
    assert(Array.isArray(build.services) && build.services.length === 1, 'Exactly one Docker service is supported');
    const service = build.services[0];
    onlyKeys(service, ['name', 'alias', 'command'], 'docker service');
    pinnedImage(service.name);
    assert(typeof service.alias === 'string' && /^[a-z][a-z0-9-]*$/.test(service.alias), 'Invalid Docker service alias');
    assert.deepEqual(service.command, ['--tls=false'], 'Rehearsal supports the declared TLS-disabled Docker service');
    onlyKeys(build.variables, ['DOCKER_HOST', 'DOCKER_TLS_CERTDIR', 'DOCKER_DRIVER'], 'docker-build.variables');
    assert.equal(build.variables.DOCKER_HOST, `tcp://${service.alias}:2375`);
    assert.equal(build.variables.DOCKER_TLS_CERTDIR, '');
    assert.equal(build.variables.DOCKER_DRIVER, 'overlay2');
    return {nodeImage, cliImage, service, variables: build.variables,
        internalCommand: internal.script[0], buildCommand: [...build.before_script, build.script[0]].join(' && ')};
}

function includeSource(file) {
    const parts = file.split('/');
    if (parts.some(part => ['.git', 'node_modules', 'tmp', 'logs', 'coverage', '.npm', '.cache', '.codex', '.agents'].includes(part))) return false;
    const name = parts.at(-1);
    return !/^\.env(?:\.|$)|^\.npmrc$|^\.netrc$|\.(?:log|pem|key)$/.test(name) &&
        !['server.pid', 'deployment-immutable.yaml'].includes(name);
}

function snapshot(root, destination) {
    // Read current files rather than git archive HEAD, so local edits are tested.
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}).split('\0').filter(Boolean);
    for (const file of new Set(files.filter(includeSource))) {
        const source = path.join(root, file);
        if (!fs.existsSync(source)) continue; // A tracked file deleted locally.
        // Reject symlinks, including ancestor directories, rather than copying
        // content from outside the checkout into the rehearsal.
        let current = root;
        for (const part of file.split('/')) {
            current = path.join(current, part);
            assert(!fs.lstatSync(current).isSymbolicLink(), `Unsupported source symlink: ${file}`);
        }
        assert(fs.statSync(source).isFile(), `Unsupported source entry: ${file}`);
        const target = path.join(destination, file);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.copyFileSync(source, target);
        fs.chmodSync(target, fs.statSync(source).mode);
    }
}

function command(args, {log, signal, capture = false} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, {stdio: ['ignore', 'pipe', 'pipe'], signal});
        let output = '';
        for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
            stream.on('data', chunk => {
                if (log) fs.appendFileSync(log, chunk);
                if (capture) output += chunk.toString();
                else terminal.write(chunk);
            });
        }
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(output.trim()) :
            reject(new Error(`docker ${args[0]} failed (exit ${code}); see ${log || 'output above'}`)));
    });
}

async function rehearse(mode, {root = path.resolve(__dirname, '../..'), output, execute = command} = {}) {
    assert(['internal', 'build'].includes(mode), 'Choose internal or build');
    const config = readConfig(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'));
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    const name = `biovalidator-preflight-${mode}-${randomUUID()}`;
    output ||= path.join(root, 'tmp', 'preflight', mode);
    fs.mkdirSync(output, {recursive: true});
    const log = path.join(output, 'rehearsal.log');
    fs.writeFileSync(log, `Rehearsing ${mode} at ${revision}\n`);
    fs.rmSync(path.join(output, 'deployment-immutable.yaml'), {force: true});
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const containers = [];
    let network = false;
    const run = (args, options = {}) => execute(args, {log, signal: controller.signal, ...options});
    let failure;
    try {
        snapshot(root, directory);
        await run(['info'], {capture: true});
        const image = mode === 'internal' ? config.nodeImage : config.cliImage;
        await run(['pull', image]);
        const environment = {CI: 'true'};
        const networkArgs = [];
        if (mode === 'build') {
            await run(['pull', config.service.name]);
            await run(['network', 'create', name]);
            network = true;
            const daemon = `${name}-docker`;
            containers.push(daemon);
            // No published daemon port, host socket, credentials, or host mounts.
            await run(['run', '-d', '--privileged', '--name', daemon, '--network', name,
                '--network-alias', config.service.alias,
                ...Object.entries(config.variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
                config.service.name, ...config.service.command]);
            networkArgs.push('--network', name);
            Object.assign(environment, config.variables, {
                CI_NODE_IMAGE: config.nodeImage, CI_REGISTRY_IMAGE: 'biovalidator',
                CI_COMMIT_REF_SLUG: 'preflight', CI_COMMIT_SHORT_SHA: revision.slice(0, 8), CI_COMMIT_SHA: revision
            });
        }
        containers.push(name);
        await run(['create', '--name', name, ...networkArgs,
            ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
            '--workdir', '/workspace', '--entrypoint', 'sh', image, '-ec',
            mode === 'internal' ? config.internalCommand : config.buildCommand]);
        await run(['cp', `${directory}/.`, `${name}:/workspace`]);
        await run(['start', '--attach', name]);
        // docker start --attach is not relied on to propagate the job exit code.
        const status = await run(['inspect', '--format', '{{.State.ExitCode}}', name], {capture: true});
        assert.equal(status, '0', `Rehearsed ${mode} job failed with exit ${status}`);
        if (mode === 'build') {
            await run(['cp', `${name}:/workspace/deployment-immutable.yaml`, path.join(output, 'deployment-immutable.yaml')]);
        }
        console.log(`${mode} rehearsal passed. Evidence: ${output}`);
    } catch (error) {
        failure = error;
        for (const container of containers) {
            await execute(['logs', container], {log}).catch(() => {});
        }
    } finally {
        // Cleanup deliberately ignores the aborted signal.
        for (const container of containers.reverse()) {
            await execute(['rm', '-f', '-v', container], {log}).catch(error => { failure ||= error; });
        }
        if (network) await execute(['network', 'rm', name], {log}).catch(error => { failure ||= error; });
        fs.rmSync(directory, {recursive: true, force: true});
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
    }
    if (failure) throw failure;
}

async function main() {
    const mode = process.argv[2] || 'all';
    assert(['all', 'internal', 'build'].includes(mode), 'Usage: node scripts/ci/rehearse-gitlab.js [all|internal|build]');
    for (const job of mode === 'all' ? ['internal', 'build'] : [mode]) await rehearse(job);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {readConfig, includeSource, snapshot, rehearse};
