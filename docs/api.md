# HTTP API

The default base URL is `http://localhost:3020/`. `BIOVALIDATOR_BASE_URL` may add a prefix to every path. Requests with a body use `Content-Type: application/json`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Bundled browser interface. |
| `GET` | `/validate` | Validation request example. |
| `POST` | `/validate` | Validate `data` against `schema`. |
| `GET` | `/examples` | FEGA examples; `refresh=true` fetches a replacement, warms successful outbound responses, and swaps it into the cache only after success. |
| `GET` | `/cache` | Registered schema IDs, schema/raw-content cache metrics, and API-response cache metrics. |
| `DELETE` | `/cache` | Clear `all`, `schemas`, or `api` caches using the optional `scope` query parameter. The default is `all`. |
| `GET` | `/health` | Process-local liveness, validation counters, and cache metrics. |

`GET /examples` reads minimal valid example wrappers from the
[`EGA-archive/fega-metadata-schema`](https://github.com/EGA-archive/fega-metadata-schema)
repository at the `main` branch by default. Set `FEGA_METADATA_SCHEMA_REPO` or
`FEGA_METADATA_SCHEMA_REF` to override the source repository or branch.

## Validation

`POST /validate` accepts an object with required `schema` and `data` properties. A `200` response contains an empty array when the data is valid, or validation errors when it is invalid. Malformed requests return `400`. Security and capacity rejections use `413`, `422`, `429`, `502`, `503`, or `504` as appropriate and contain `code`, `configuration`, and local-deployment guidance. See [server security controls](security.md).

## Cache

`GET /cache` groups in-process schema state under `schemas.registered`, `schemas.validatorID`, and `schemas.referenced`; `worker_schemas` reports the union observed in validation workers. Registered schemas come from `--ref`; `validatorID` lists cached top-level schema labels; referenced schemas were fetched remotely. The response has two cache classes:

- `api` is the one bounded API-response cache for OLS, ENA Taxonomy, identifiers.org, and GitHub API responses. It reports counts, total weight, TTL, and lifecycle timestamps without exposing API query URLs or cached bodies.
- `outbound.schemas` is the separate remote-content cache for referenced schemas and raw FEGA example files. It includes the remote URL inventory; `outbound.in_flight` and `outbound.outbound` report current request activity.

The relevant `/cache` shape is:

```json
{
  "api": {
    "entries": {
      "total": 0,
      "ols": 0,
      "ena_taxonomy": 0,
      "identifiers_org": 0,
      "github_api": 0
    },
    "weight_bytes": 0,
    "providers": {}
  },
  "outbound": {
    "schemas": {
      "entries": 0,
      "weight_bytes": 0,
      "urls": []
    },
    "in_flight": 0,
    "outbound": {
      "active": 0,
      "queued": 0
    }
  }
}
```

The live response also includes `schemas` and, when workers are enabled,
`worker_schemas` for schema inventories.

All runtime entry points use the same strict outbound policy: HTTPS-only requests,
fixed destinations for supported upstream services, and the configured allowlist
for remote schemas.

`DELETE /cache` clears transient schema and/or API caches. The assembled
`/examples` payload is invalidated for every scope so a later fetch cannot
silently reuse a payload whose outbound responses were deleted. Within the
shared outbound cache, `scope=schemas` clears remote schema and raw GitHub
example responses, while `scope=api` clears upstream API responses including
the GitHub tree. Registered local schemas remain available because they are
server configuration rather than cache entries.

The cache endpoints are enabled by default for local operational visibility. Set
`BIOVALIDATOR_CACHE_ENDPOINT_ENABLED=false` at process startup to leave both
`GET /cache` and `DELETE /cache` unregistered; requests then receive `404`.

## Health

`GET /health` returns `200` when the process can serve the request. It does not probe OLS, ENA Taxonomy, identifiers.org, or other upstream services. Counters and cache history reset when the process restarts and are not aggregated across replicas.

| Field | Meaning |
| --- | --- |
| `status` | Process liveness; currently `ok`. |
| `timestamp` | UTC time at which the snapshot was generated. |
| `version` | Biovalidator package version. |
| `uptime_seconds`, `process_started_at` | Process lifetime and calculated UTC start time. |
| `deployed_at` | `BIOVALIDATOR_DEPLOYED_AT`, or process start time when unset. |
| `revision` | `BIOVALIDATOR_REVISION`, or the local Git commit; `null` when neither is available. |
| `dependency_versions` | Node.js and npm versions in the running deployment. `npm` is `null` when its binary is unavailable. |
| `validation.requests` | POST `/validate` totals: all received, 2xx successes, failed/aborted requests, and requests in flight. |
| `validation.results` | Valid and invalid outcomes among successfully processed validations. |
| `cache.schemas.entries` | Total current schema entries, split into compiled validators and referenced schemas. |
| `cache.api.entries` | Total current API-response entries, split into `ols`, `ena_taxonomy`, `identifiers_org`, and `github_api`. |
| `cache.api.weight_bytes` | Total weighted size of the central API-response cache. |
| `cache.api.providers.<provider>.entries` | Current entry count for one API provider. |
| `cache.api.providers.<provider>.ttl_seconds` | Configured lifetime for that provider's API responses. |
| `cache.api.providers.<provider>.last_updated_at`, `last_cleared_at` | Last API-cache write and clear times; `null` before that event occurs. |
| `cache.api.providers.<provider>.oldest_entry_at`, `newest_entry_at` | Estimated insertion boundaries for current provider entries; `null` when empty. |
| `cache.api.providers.<provider>.next_expiration_at` | Earliest scheduled expiration among current provider entries; `null` when none exists. |

Schema, remote-content, and API-response cache entries use the `BIOVALIDATOR_CACHE_TTL_SECONDS` setting, which defaults to 21,600 seconds (6 hours). The effective value appears in the relevant `ttl_seconds` fields. Configuration is read at process startup. The assembled FEGA examples payload uses the separate `FEGA_EXAMPLES_CACHE_TTL_SECONDS` setting, and forced refreshes are rate limited by `BIOVALIDATOR_EXAMPLES_REFRESH_MIN_INTERVAL_MS`.

Implementation-level details are documented in [`server.js`](../src/core/server.js), [`biovalidator-core.js`](../src/core/biovalidator-core.js), [`secure-http-client.js`](../src/utils/secure-http-client.js), [`fega_examples_client.js`](../src/utils/fega_examples_client.js), and [`cache-metrics.js`](../src/utils/cache-metrics.js).
