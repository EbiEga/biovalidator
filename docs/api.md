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
| `GET` | `/ready` | Readiness: `200` when available, `503` while draining or after a worker failure. |
| `GET` | `/health` | Rate-limited deployment details, validation counters, and cache metrics. |
| `GET` | `/live` | Lightweight process liveness; available while draining. |

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

Cache administration is disabled by default (`404`). Enable both routes only for
protected operational access with `BIOVALIDATOR_CACHE_ENDPOINT_ENABLED=true`.

## Health

Use `/live` for liveness probes. Detailed `/health` metrics are subject to the normal request rate limit.

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


## Validation failure categories

Invalid data returns `200` with a non-empty error array. An invalid schema returns `422` with `SCHEMA_COMPILATION_FAILED`. Upstream unavailability or malformed provider responses return `502`; outbound deadlines return `504`. Those service errors do not mean the submitted data is invalid.

For `graphRestriction`, provide exactly one parent-term array: `childrenOf` or `allChildrenOf`. The selected name is sent unchanged to OLS after expanding parent CURIEs to IRIs. `classes`, `direct`, and `relations` are rejected as invalid schema options (`422`, `SCHEMA_COMPILATION_FAILED`); OLS search does not expose arbitrary relation selection. See the [OLS search parameter documentation](https://www.ebi.ac.uk/ols4/ols3help). Boolean keywords accept both actual booleans and their legacy string forms; `false` and `"false"` disable the check.

Draft-06/07 schemas use a legacy context; 2019-09 and 2020-12 use separate contexts. A remote root reference without `$schema` selects the referenced document's declared draft. Remote boolean schemas are supported. Schema-side linting remains recommended; optional strict annotation configuration is documented in [security controls](security.md).

The CLI exits `0` for valid data, `1` for invalid data, and `2` when validation could not run (including file or schema errors). JSON values `false`, `0`, `null`, and the empty string are valid inputs and are checked normally.

Browser verdicts are cleared after edits; results from an older input version are ignored. Visiting a configured URL prefix without a trailing slash redirects to the correct UI path.

Under contention, long-running computation can return `503` with `VALIDATION_PRESSURE_LIMIT`. Quiet requests retain the ordinary validation deadline. See [processing pressure controls](security.md#compilation-isolation-and-processing-pressure). Client disconnects cancel their validation work.
