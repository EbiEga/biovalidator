# Server security controls

Biovalidator's server profile accepts untrusted schemas and data while retaining remote `$ref`, OLS, ENA Taxonomy, identifiers.org, and FEGA example fetching. The controls below are deployment limits, not JSON Schema semantics. A limit rejection contains a stable `code`, the relevant `configuration`, and guidance for running a separately configured local deployment.

## Outbound requests

Server-side remote `$ref` requests must use credential-free HTTPS on port 443 and match an exact URL prefix in `BIOVALIDATOR_REMOTE_REF_ALLOWLIST`. The default is `https://raw.githubusercontent.com/`. Literal IP addresses, redirects, non-HTTP protocols, and lookalike hostnames are rejected. OLS, ENA Taxonomy, identifiers.org, and the GitHub API use fixed destinations from the application rather than user-selected hosts.

Remote schemas are still supported. Responses are fetched, compiled, and cached by URL; compiled root schemas are cached by a canonical SHA-256 content digest. Local `--ref` registrations take authoritative precedence. A submitted inline schema cannot replace a local or previously verified remote `$id` with different content. If a remote document declares a different URL as its `$id`, the server fetches that canonical URL and requires its content to match before reserving the identifier. Local and outbound response caches are shared between users. Production validation workers keep their compiled caches locally, with content affinity routing repeat uses to a warm idle worker when possible.

The browser UI uses a per-response CSP nonce for CodeMirror's runtime-generated stylesheet. HTML UI responses are not cached so the nonce in the document always matches the nonce in the response policy; no general inline-style allowance is enabled.

Use repeatable `--remoteRef URL` arguments to fetch and compile important allowlisted schemas before the HTTP listener starts. This warms the shared response cache. Local schemas supplied with `--ref` are loaded and registered at startup and remain available through their `$id`.

## Cache endpoint exposure

`GET /cache` includes schema identifiers and a bounded remote URL inventory, and `DELETE /cache` changes process-wide transient cache state. They remain enabled by default for compatibility with local deployments. Public deployments should either hide these behind authorisation or set `BIOVALIDATOR_CACHE_ENDPOINT_ENABLED=false`. Disabling them removes both routes while keeping `/health` available.

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
| `BIOVALIDATOR_WORKERS` | available CPU parallelism | Maximum lazily created validation workers. |
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

- We still don't have an ingress/reverse-proxy connection and request-rate policy in front of a public server deployment. Application worker and queue bounds protect validation capacity, but they do not replace edge rate limiting. In other words, people can still abuse the public servers in other ways.
- Disable `/cache` on public deployments unless its operational inventory and cache-clearing action are intentionally exposed.
