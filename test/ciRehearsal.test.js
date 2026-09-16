const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
jest.mock('child_process', () => ({...jest.requireActual('child_process'), execFileSync: jest.fn()}));
const {execFileSync, spawnSync} = require('child_process');
const {readConfig, snapshot, rehearse} = require('../scripts/ci/rehearse-gitlab');

const repository = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repository, '.gitlab-ci.yml'), 'utf8');
let directory;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biovalidator-ci-test-'));
    fs.writeFileSync(path.join(directory, '.gitlab-ci.yml'), source);
    execFileSync.mockImplementation((_command, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : '.gitlab-ci.yml\0');
});
afterEach(() => {
    execFileSync.mockReset();
    fs.rmSync(directory, {recursive: true, force: true});
});

test('rehearsal reads pinned images and the Docker service from GitLab', () => {
    const config = readConfig(source);
    expect(config.nodeImage).toContain('@sha256:');
    expect(config.cliImage).toContain('@sha256:');
    expect(config.service.name).toContain('@sha256:');
    expect(config.buildCommand).toBe('sh scripts/ci/wait-docker.sh && sh scripts/ci/verify-image.sh');
    expect(config.buildCommand).not.toContain('publish');
});

test.each([
    config => { config['internal-tests'].before_script = ['apt-get install git']; },
    config => { config['internal-tests'].script.push('another-check'); },
    config => { config['docker-build'].script.reverse(); },
    config => { config['docker-build'].variables.EXTRA_TOOL = 'yes'; },
    config => { config['docker-build'].services[0].command.push('--experimental'); },
    config => { config['docker-build'].image = 'docker:latest'; },
    config => { config.default = {before_script: ['another-check']}; }
])('environment or command drift cannot silently weaken the rehearsal', mutate => {
    const config = yaml.load(source);
    mutate(config);
    expect(() => readConfig(yaml.dump(config))).toThrow();
});

test('source snapshot includes edits and new tests but excludes dependencies, secrets and output', () => {
    const files = ['src/edited.js', 'test/new.test.js', 'node_modules/host.js', '.env', '.npmrc', 'tmp/output',
        'secret.key', '.git/config', 'deployment-immutable.yaml', 'deleted.js'];
    for (const file of files.filter(file => file !== 'deleted.js')) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive: true});
        fs.writeFileSync(path.join(directory, file), 'current worktree contents');
    }
    execFileSync.mockReturnValue(files.join('\0'));
    const destination = path.join(directory, 'snapshot');
    snapshot(directory, destination);
    expect(fs.readFileSync(path.join(destination, 'src/edited.js'), 'utf8')).toBe('current worktree contents');
    expect(fs.existsSync(path.join(destination, 'test/new.test.js'))).toBe(true);
    for (const file of files.slice(2)) expect(fs.existsSync(path.join(destination, file))).toBe(false);
});

test('source snapshots reject symlinks rather than copying their targets', () => {
    fs.symlinkSync(os.tmpdir(), path.join(directory, 'outside'));
    execFileSync.mockReturnValue('outside\0');
    expect(() => snapshot(directory, path.join(directory, 'snapshot'))).toThrow('symlink');
});

test.each(['success', 'job failure', 'daemon start failure', 'missing docker'])
('rehearsal propagates outcomes and cleans up: %s', async outcome => {
    const execute = jest.fn(async args => {
        if (outcome === 'missing docker' && args[0] === 'info') throw new Error('spawn docker ENOENT');
        if (outcome === 'daemon start failure' && args[0] === 'run') throw new Error('daemon failed');
        if (args[0] === 'inspect') return outcome === 'job failure' ? '7' : '0';
        return '';
    });
    const result = rehearse('build', {root: directory, execute});
    if (outcome === 'success') await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow();
    const calls = execute.mock.calls.map(([args]) => args);
    expect(calls.flat().join(' ')).not.toMatch(/dockerhub|publish-image|password|docker\.sock/);
    if (outcome !== 'missing docker') {
        expect(calls.some(args => args[0] === 'rm' && args.includes('-v'))).toBe(true);
        expect(calls.at(-1).slice(0, 2)).toEqual(['network', 'rm']);
    }
    if (outcome === 'job failure') expect(calls.some(args => args[0] === 'logs')).toBe(true);
});

function executable(name, contents) {
    fs.writeFileSync(path.join(directory, name), `#!/bin/sh\n${contents}\n`, {mode: 0o700});
}

test('Docker readiness timeout fails after bounded attempts', () => {
    executable('docker', 'exit 1');
    executable('sleep', 'exit 0');
    const result = spawnSync('/bin/sh', [path.join(repository, 'scripts/ci/wait-docker.sh')], {
        env: {...process.env, PATH: directory}, encoding: 'utf8', timeout: 5000
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Docker daemon did not become ready');
});

test.each([false, true])('shared internal checks fail when npm is missing or fails: installed=%s', installed => {
    if (installed) executable('npm', 'exit 9');
    const result = spawnSync('/bin/sh', [path.join(repository, 'scripts/ci/check-internal.sh')], {
        env: {...process.env, PATH: directory}, encoding: 'utf8'
    });
    expect(result.status).toBe(installed ? 9 : 127);
});

test('verification stops at a failed build before scanning or rendering', () => {
    const scripts = path.join(directory, 'scripts/ci');
    fs.mkdirSync(scripts, {recursive: true});
    fs.copyFileSync(path.join(repository, 'scripts/ci/image-env.sh'), path.join(scripts, 'image-env.sh'));
    fs.writeFileSync(path.join(scripts, 'check-container.sh'), 'exit 7\n');
    const result = spawnSync('/bin/sh', [path.join(repository, 'scripts/ci/verify-image.sh')], {
        cwd: directory, encoding: 'utf8', env: {...process.env, CI_NODE_IMAGE: 'node', CI_REGISTRY_IMAGE: 'app',
            CI_COMMIT_REF_SLUG: 'preflight', CI_COMMIT_SHORT_SHA: 'abc', CI_COMMIT_SHA: 'abc'}
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toBe('');
    expect(fs.existsSync(path.join(directory, 'deployment-immutable.yaml'))).toBe(false);
});

test.each(['success', 'failure', 'cancelled', 'skipped'])('aggregate check enforces prerequisite result %s', status => {
    const workflow = yaml.load(fs.readFileSync(path.join(repository, '.github/workflows/ci.yml'), 'utf8'));
    const gate = workflow.jobs.preflight;
    expect(gate.name).toBe('Deployment preflight');
    expect(gate.if).toBe('always()');
    expect(gate.needs).toEqual(['test', 'rehearsal']);
    for (const prerequisite of ['TEST_RESULT', 'REHEARSAL_RESULT']) {
        const result = spawnSync('/bin/sh', ['-e', '-c', gate.steps[0].run], {
            env: {...process.env, TEST_RESULT: 'success', REHEARSAL_RESULT: 'success', [prerequisite]: status}
        });
        expect(result.status).toBe(status === 'success' ? 0 : 1);
    }
});
