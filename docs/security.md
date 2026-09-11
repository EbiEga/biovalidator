# Server security controls

Biovalidator accepts untrusted schemas and data while retaining allowlisted remote `$ref`, OLS, ENA Taxonomy, identifiers.org, and FEGA example fetching. The controls below are deployment limits, not JSON Schema semantics. A limit rejection contains a stable `code`, the relevant `configuration`, and guidance for running a separately configured deployment.

All runtime entry points use the same strict outbound policy: HTTPS-only
requests, fixed destinations for supported upstream services, and the
configured allowlist for remote schemas.

## Outbound requests

Server-side remote `$ref` requests must use credential-free HTTPS on port 443 and match an exact URL prefix in `BIOVALIDATOR_REMOTE_REF_ALLOWLIST`. The default is `https://raw.githubusercontent.com/`. Literal IP addresses, redirects, non-HTTP protocols, and lookalike hostnames are rejected. OLS, ENA Taxonomy, identifiers.org, and the GitHub API use fixed destinations from the application rather than user-selected hosts.

The HTTPS transport checks every resolved IPv4/IPv6 address when opening a connection and rejects private, loopback, link-local, reserved and other non-public destinations (`OUTBOUND_ADDRESS_DENIED`). The socket uses those checked DNS answers directly, avoiding a second lookup that could change the destination. Hostnames and certificate verification remain intact. Mixed public/private DNS answers are rejected.

Implicit `HTTP_PROXY`/`HTTPS_PROXY` and Node environment proxies are disabled for validation traffic so that a proxy cannot bypass these destination checks. Deployments needing an egress proxy must provide an explicitly reviewed transport policy; setting an environment proxy alone is insufficient. Allowlisted internal-only schema hosts are rejected; use local `--ref` registrations for internal schemas.

Remote schemas are supported. Responses are fetched, compiled, and cached by URL; compiled root schemas are cached by a canonical SHA-256 content digest. Local `--ref` registrations take authoritative precedence. A submitted inline schema cannot replace a local or previously verified remote `$id` with different content. If a remote document declares a different URL as its `$id`, the server fetches that canonical URL and requires its content to match before reserving the identifier. The API-response and remote-content caches are shared by the server and its validation workers within one server instance. Validation workers keep their compiled schema caches locally, with content affinity routing repeat uses to a warm idle worker when possible.

The browser UI uses a per-response CSP nonce for CodeMirror's runtime-generated stylesheet. HTML UI responses are not cached so the nonce in the document always matches the nonce in the response policy; no general inline-style allowance is enabled.

Use repeatable `--remoteRef URL` arguments to fetch and compile important allowlisted schemas before the HTTP listener starts. This warms the shared remote-content cache. Local schemas supplied with `--ref` are loaded and registered at startup and remain available through their `$id`.

## Cache endpoint exposure

`GET /cache` exposes schema identifiers, remote-content URL inventory, and aggregate API-cache metadata (counts, weights, TTLs, and lifecycle timestamps). It does not expose API query URLs or cached response bodies. `DELETE /cache` changes transient cache state for the server instance: `scope=api` clears API responses, `scope=schemas` clears referenced schemas and raw FEGA files, and `scope=all` clears both. Every scope also invalidates the assembled FEGA examples payload. The routes are disabled by default. Set `BIOVALIDATOR_CACHE_ENDPOINT_ENABLED=true` only for local/private operational access, or protect them with authorisation at your proxy. Disabling them removes both routes while keeping `/health` available.

## Default limits

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `BIOVALIDATOR_REQUEST_MAX_BYTES` | 4 MiB | JSON HTTP request body. |
| `BIOVALIDATOR_REMOTE_SCHEMA_MAX_BYTES` | 1 MiB | One remote schema document. |
| `BIOVALIDATOR_REMOTE_SCHEMA_TOTAL_BYTES` | 4 MiB | Remote schema documents used by one validation. |
| `BIOVALIDATOR_REMOTE_DOCUMENT_MAX` | 128 | Remote schema documents used by one validation. |
| `BIOVALIDATOR_SCHEMA_MAX_DEPTH` | 64 | Nesting depth of an untrusted schema. |
| `BIOVALIDATOR_SCHEMA_MAX_VALUES` | 50,000 | Values in an untrusted schema. |
| `BIOVALIDATOR_OUTBOUND_TIMEOUT_MS` | 20,000 | One outbound request. |
| `BIOVALIDATOR_VALIDATION_TIMEOUT_MS` | 60,000 | One validation running in a worker. |
| `BIOVALIDATOR_QUEUE_TIMEOUT_MS` | 10,000 | Maximum wait for a validation worker. |
| `BIOVALIDATOR_WORKERS` | up to 2, limited by available CPU parallelism | Maximum lazily created validation workers. |
| `BIOVALIDATOR_QUEUE_PER_WORKER` | 2 | Bounded queued validations per configured worker. |
| `BIOVALIDATOR_OUTBOUND_CONCURRENCY` | 16 | Concurrent upstream requests. |
| `BIOVALIDATOR_API_RESPONSE_MAX_BYTES` | 8 MiB | One OLS, ENA, or identifiers.org response page. |
| `BIOVALIDATOR_GITHUB_TREE_MAX_BYTES` | 5 MiB | FEGA Git tree response. |
| `BIOVALIDATOR_GITHUB_TREE_MAX_ENTRIES` | 10,000 | Entries in the FEGA Git tree. |
| `BIOVALIDATOR_FEGA_EXAMPLE_MAX_ENTRIES` | 100 | Matching minimal FEGA examples. |
| `BIOVALIDATOR_CUSTOM_KEYWORD_ARRAY_MAX` | 64 | Terms in one custom-keyword array. |
| `BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES` | 8 KiB | One custom-keyword query string. |
| `BIOVALIDATOR_REMOTE_SCHEMA_CACHE_MAX_BYTES` | 128 MiB | Shared remote-content cache weight. |
| `BIOVALIDATOR_REMOTE_SCHEMA_CACHE_MAX_ENTRIES` | 2,048 | Shared remote-content cache entries. |
| `BIOVALIDATOR_API_CACHE_MAX_BYTES` | 256 MiB | Shared upstream API cache weight. |
| `BIOVALIDATOR_API_CACHE_MAX_ENTRIES` | 100,000 | Shared upstream API cache entries. |
| `BIOVALIDATOR_COMPILED_CACHE_MAX_ENTRIES` | 512 | Compiled schemas per worker/draft context. |
| `BIOVALIDATOR_EXAMPLES_REFRESH_MIN_INTERVAL_MS` | 60,000 | Minimum interval for forced FEGA example refreshes. |

All numeric settings must be positive whole numbers and are read at startup. `BIOVALIDATOR_REMOTE_REF_ALLOWLIST` is a comma-separated list of HTTPS URL prefixes. An empty allowlist is rejected because remote resolution is part of the service; use tightly scoped repository prefixes where practical.

These single-document defaults were calibrated using the `fega-metadata-schema` of `EGA-archive`, multiplying the current sizes 5fold. The aggregate, document-count, depth, and value defaults also leave substantial growth above the measured current FEGA schema closure.

`BIOVALIDATOR_DISABLE_WORKERS=true` is intended only for trusted local debugging. It removes the worker-enforced 60-second execution boundary and should not be used for a public endpoint.

## Limit response

For example:

```json
{
  "error": "The request body exceeded this Biovalidator deployment's 4194304-byte limit.",
  "code": "REQUEST_BODY_SIZE_LIMIT",
  "limit": {
    "name": "request_max_bytes",
    "configured": 4194304,
    "observed": 5000000,
    "unit": "bytes"
  },
  "configuration": "BIOVALIDATOR_REQUEST_MAX_BYTES",
  "help": "This is a safety limit imposed by this Biovalidator deployment. Deploy Biovalidator locally or change the documented configuration when trusted schemas or data require a higher limit."
}
```

Typical status codes are `413` for an oversized request body, `422` for a schema or validation rejected by policy, `429` for forced-refresh throttling, `502` for invalid/oversized upstream content, `503` for worker capacity, and `504` for an outbound timeout.

## Deployment notes

- Application rate limits run before body parsing and are per client IP, per server process. For multiple replicas, configure shared edge quotas as needed; the effective allowance otherwise scales with replicas. Restrict direct access to the backend when trusting a proxy.
- Disable `/cache` on public deployments unless its operational inventory and cache-clearing action are intentionally exposed.


## Additional runtime controls

Settings are read at startup; restart the process after changing them. No code changes are required.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `BIOVALIDATOR_RATE_LIMIT_ENABLED` | `true` | Enable per-client request throttling; excludes `/live` and `/ready`. |
| `BIOVALIDATOR_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `BIOVALIDATOR_RATE_LIMIT_MAX` | `60` | Requests allowed per client per window per process. |
| `BIOVALIDATOR_TRUST_PROXY` | unset | Comma-separated trusted proxy IPs/CIDRs, e.g. your ingress subnet. Never trust arbitrary forwarded headers. |
| `BIOVALIDATOR_MAX_CONNECTIONS` | `256` | Open HTTP connections per process. |
| `BIOVALIDATOR_REQUEST_TIMEOUT_MS` | `30000` | Time allowed to receive an HTTP request, separate from validation execution. |
| `BIOVALIDATOR_WORKER_HEAP_MB` | `256` | Maximum old-generation JavaScript heap per worker. |
| `BIOVALIDATOR_VALIDATION_MAX_ERRORS` | `1000` | Reject larger error lists with `VALIDATION_ERROR_LIMIT`. |
| `BIOVALIDATOR_VALIDATION_RESULT_MAX_BYTES` | `1048576` | Reject oversized result payloads before sending them to the parent process. |
| `BIOVALIDATOR_SCHEMA_STRICT` | `false` | Opt in to Ajv strict schema-keyword checking. |
| `BIOVALIDATOR_ANNOTATION_KEYWORDS` | `meta:enum,meta:version` | Complete comma-separated list of allowed annotation-only keywords when using strict checking. |
| `BIOVALIDATOR_LOG_LEVEL` | `info` | Console/file log level. |
| `BIOVALIDATOR_FILE_LOG_ENABLED` | `true`, `false` in the container | Enable local rotated files in addition to stdout. |
| `BIOVALIDATOR_LOG_MAX_BYTES` | `20971520` | Rotate a log file at this size. |
| `BIOVALIDATOR_LOG_MAX_FILES` | `14` | Retain at most this many rotated files. |

Worker heap limits do not bound all native allocations or the entire process. Keep the container memory limit and size workers/cache budgets together. The validator still collects all errors for useful diagnostics; worker execution/heap bounds contain that work, and result limits reject overly large reports rather than truncating them into misleading success.

Strict schema checking remains opt-in for FEGA deployments relying on schema-side linting. Set the full annotation list before enabling it; listed annotations carry no validation semantics. Do not add a misspelled validation keyword to suppress an error. Other Ajv strict options that restrict valid JSON Schema constructs remain disabled.

Compiled validators use least-recently-used eviction instead of refusing new schemas. Ajv releases transient root references after compilation; only the bounded application cache retains those validators. Routing history is also bounded.

`/health` intentionally retains public schema URL inventories. Neither it nor `/cache` exposes API query URLs or cached response bodies. Do not use schema URLs containing secrets.

## Compilation isolation and processing pressure

Each new schema is compiled in an isolated registry. Finished validators are cached within the configured entry limit; local and downloaded reference documents remain reusable. GitHub root references and relative references are supported. Compilers load local references on demand so each new playground schema does not duplicate the full local schema collection.

The playground accepts arbitrary schemas and standard JavaScript regular expressions. Quiet requests retain `BIOVALIDATOR_VALIDATION_TIMEOUT_MS`. When other requests are queued, `BIOVALIDATOR_PRESSURE_RELIEF_ENABLED=true` permits stopping an older computation after `BIOVALIDATOR_PRESSURE_TIMEOUT_MS` (default 5000 ms) without a provider wait. The response is `503` with `VALIDATION_PRESSURE_LIMIT`; retry when quieter. Provider waiting time does not count toward this shorter computation interval. Set the enabled flag to `false` to keep only the ordinary timeout. This is a contention safeguard, not a CPU-time measurement or a guarantee of a particular availability percentage.

Aborted HTTP connections, validation deadlines and worker failures cancel the job's outstanding downloads. A shared download continues while another caller still needs it. Additional configurable limits are:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `BIOVALIDATOR_OUTBOUND_QUEUE_MAX` | `256` | Maximum downloads waiting for an outbound slot. |
| `BIOVALIDATOR_VALIDATION_OUTBOUND_MAX` | `512` | Maximum provider/reference request calls per validation, including cache hits. |
| `BIOVALIDATOR_VALIDATION_OUTBOUND_MAX_BYTES` | `67108864` | Maximum cumulative response bytes delivered to one validation, including cached responses. |

`GET /live` returns a small constant-cost liveness response and is excluded from client rate limits. `GET /health` provides detailed metrics and is rate limited like other application routes. Use `/live` for Kubernetes liveness probes.

## Data handling and logs

This service is intended for metadata suitable for eventual open access. Do not submit identifiable or confidential metadata. Ontology terms, taxonomy values and identifiers can be sent to OLS, ENA and identifiers.org. Warning and error logs may contain submitted values; operators accept the risk of accidental identifiable submissions under this usage policy.

New local log directories use owner-only access and new active log files are owner-readable/writable. Existing directories and files retain their existing permissions; keep rotated archives inside a private log directory. File count and size retention settings remain configurable. Containers log to stdout: Kubernetes/central logging administrators must restrict log access to authorized operators and configure a retention period (use 14 days or a shorter organizational requirement). Application file rotation does not enforce central log retention. Avoid granting namespace-wide pod/log access to ordinary service users. The production renderer creates a read-only log-reader Role without a binding; the administrator chooses the authorized group and must review broader existing permissions. The Role can read all pod logs in its namespace, so use a dedicated namespace.

## Production configuration

The base manifest includes a non-root identity, read-only root filesystem, disabled privilege escalation, dropped capabilities, a runtime-default seccomp profile, disabled service-account token mounting, and bounded temporary storage. It still follows the development image tag.

A production candidate can be rendered with Node after `npm ci`:

```sh
node --env-file=deploy/production.env scripts/ci/render-production.js > /tmp/biovalidator-production.yaml
node scripts/ci/check-deployment.js /tmp/biovalidator-production.yaml --production
```

The environment file must supply `PUBLIC_HOST`, `DEPLOY_NAMESPACE`, `TLS_SECRET`, `INGRESS_CLASS`, `INGRESS_NAMESPACE`, `INGRESS_POD_LABEL` (`key=value`), `TRUST_PROXY_CIDRS`, and `EGRESS_CIDRS` (comma-separated ranges). `DEPLOY_IMAGE` optionally selects a particular build. Supply actual reviewed ranges, never unrestricted `/0` ranges. Do not reuse documentation example ranges in a deployment.

This profile assumes a controller honoring `nginx.ingress.kubernetes.io` redirect and rate-limit annotations. The administrator must confirm controller support and its maintained version before applying it, or adapt the profile to the controller actually in use. The renderer does not install a controller or issue certificates. `TLS_SECRET` must already contain the certificate for `PUBLIC_HOST`. Use a dedicated namespace; the target namespace and the image-pull secret referenced by the deployment must already exist. Optional `INGRESS_RATE_RPS` and `INGRESS_CONNECTIONS` default to 10 and 20. These edge quotas may be per controller replica; use shared quotas when scaling and verify that the controller overwrites untrusted forwarding headers. The application's trusted ranges must match actual backend connections, not arbitrary client-supplied headers.

The NetworkPolicy permits ingress only from the supplied namespace/pod selector and outbound HTTPS only to the supplied ranges. It permits DNS to `kube-system` pods labeled `k8s-app=kube-dns`; adapt this if the cluster uses NodeLocal DNS or other resolver placement. Provider addresses can change: the administrator should maintain approved ranges or replace the egress rule with an equivalent supported FQDN policy/controlled egress gateway. Verify CNI enforcement, service/NAT behavior and that the selected ranges do not expose internal services or cloud metadata. Standard NetworkPolicy does not filter by hostname.

Before exposing the domain, the Kubernetes team must verify TLS/redirect behavior, client-IP handling and spoof rejection, network isolation, namespace security admission, and central log permissions/retention. Rendered configuration alone does not establish that cluster controls are active.

CI checks deployment policy and scans the final container image for High/Critical vulnerabilities and secrets before publication. `sh scripts/ci/scan-container.sh` uses Trivy and fails on findings or scan errors; scanning requires a working Docker daemon. Upgrade the pinned scanner version deliberately. Do not suppress release failures without an explicit, dated security exception.
