# CI rehearsals and merge protection

GitHub and GitLab use the same verification scripts. GitHub also runs them in
the job images and Docker service declared in `.gitlab-ci.yml`. This catches
missing executables and differences in Node, npm, Docker, shell behavior, and
the container filesystem while changes are still in a pull request.

## Run locally

Use Git, Node.js 22 or newer, and Docker with Linux containers. On Windows,
run these commands in WSL2 with Docker Desktop's WSL integration enabled.
Docker must support a privileged Docker-in-Docker container. The rehearsal
does not mount the host Docker socket inside its containers or expose the
inner daemon on a host port.

```sh
npm run ci:preflight
```

After `npm ci`, either rehearsal can also be run independently:

```sh
node scripts/ci/rehearse-gitlab.js internal
node scripts/ci/rehearse-gitlab.js build
```

The launcher copies current tracked files and non-ignored new files, including
uncommitted edits. It omits Git metadata, host dependencies, common credential
files, and generated output. Source symlinks are rejected. Keep private files
out of the source tree and ignored by Git. Test and deployment files are
included even though the production Docker build excludes them.

The internal rehearsal runs locked installation, deployment policy checks,
serial internal tests, and the production dependency audit. The build rehearsal
uses a fresh Docker daemon to build and smoke-test the application, scan it,
render its image reference, and validate its routing. Render validation uses
the same Node image and locked tooling in a separate container because the
Docker CLI image has no Node installation. No registry credentials are supplied
and the publication script is never invoked.

Logs are saved under `tmp/preflight/internal/` and `tmp/preflight/build/`.
A successful build also saves `deployment-immutable.yaml` in the build output
directory. Its image tag is local to the rehearsal and is **not a published
deployment artifact**. GitLab produces its own manifest with the registry tag.
The launcher removes temporary source copies, containers, anonymous Docker
volumes, and networks after success, failure, or normal interruption. Downloaded
outer job images remain in Docker's ordinary image cache.

## GitHub checks

The main CI workflow runs on PRs targeting `main` or `dev`, pushes to those
branches, manual dispatch, and Mondays at 08:00 UTC. It retains the Node
22/24/26 compatibility matrix. The two rehearsal jobs run independently and
upload logs and the rendered manifest as artifacts retained for 14 days.

**Deployment preflight** succeeds only when the entire compatibility matrix
and both rehearsals succeed. Failure, cancellation, and skipped prerequisites
cannot produce a successful aggregate status. Live external-provider smoke
tests remain separate from this required check.

### One-time repository ruleset setup

Workflow YAML reports status; GitHub repository settings enforce it. After the
workflow is available on GitHub, authenticate `gh` as a repository administrator
and inspect existing rulesets:

```sh
gh auth login
gh api repos/EbiEga/biovalidator/rulesets
```

The reviewed request body in `scripts/ci/deployment-ruleset.json` creates an
additive rule for `main` and `dev`: changes require a PR, an up-to-date branch,
and a successful **Deployment preflight** status from GitHub Actions. It adds
no approval-count requirement and preserves other rulesets. If a ruleset named
`Deployment preflight` already exists, inspect it and update that rule rather
than creating a duplicate.

```sh
gh api --method POST repos/EbiEga/biovalidator/rulesets \
  --input scripts/ci/deployment-ruleset.json
```

Validate enforcement with a draft test PR: introduce a deliberate failing
internal assertion, confirm the failed aggregate prevents merging, then remove
the assertion and confirm the passing check satisfies the rule. Close the test
PR without merging. Local tests verify the aggregate's exit behavior but cannot
prove that GitHub repository settings have been enabled.

## Maintain the checks

- Keep verification commands in `check-internal.sh` and `verify-image.sh` and
  their shared helpers. GitLab invokes `publish-image.sh` only after verification.
- Update Node's `CI_NODE_IMAGE` and the Docker CLI/service image references in
  `.gitlab-ci.yml`. Each reference includes a version tag and registry digest.
  Use `docker buildx imagetools inspect IMAGE:TAG` to resolve a new digest, and
  update the Docker CLI/service pair together. GitHub reads these values directly.
- Keep Dependabot's npm, GitHub Actions, and application Dockerfile updates.
  GitLab job images and the scanner's shell-script pin still need occasional
  deliberate updates. The weekly workflow exposes new scan findings between
  dependency updates; findings and scanner errors continue to fail verification.
- The launcher deliberately supports only these two job environments. Changes
  to job hooks, commands, variables, images, services, or template declarations
  outside that contract fail with a configuration error. Extend the rehearsal
  explicitly when adding such behavior instead of bypassing its validation.

The rehearsal does not emulate GitLab's scheduler, included security-template
jobs, or runner administrator configuration. Registry credentials and outages,
cluster permissions, scheduling, ingress controllers, network policy enforcement,
and admission policies still require GitLab or cluster-side checks. The checked-in
development deployment continues following `:main`; production rollout behavior
is unchanged.
