# HTTP API

The default base URL is `http://localhost:3020/`. `BIOVALIDATOR_BASE_URL` may add a prefix to every path. Requests with a body use `Content-Type: application/json`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Bundled browser interface. |
| `GET` | `/validate` | Validation request example. |
| `POST` | `/validate` | Validate `data` against `schema`. |
| `GET` | `/examples` | FEGA examples; `refresh=true` fetches a replacement and swaps it into the cache only after success. |
| `GET` | `/cache` | Registered schema IDs, transient schema cache keys, and API cache metrics. |
| `DELETE` | `/cache` | Clear `all`, `schemas`, or `api` caches using the optional `scope` query parameter. The default is `all`. |
| `GET` | `/health` | Process-local liveness, validation counters, and cache metrics. |

## Validation

`POST /validate` accepts an object with required `schema` and `data` properties. A `200` response contains an empty array when the data is valid, or validation errors when it is invalid. Malformed requests return `400`. Security and capacity rejections use `413`, `422`, `429`, `502`, `503`, or `504` as appropriate and contain `code`, `configuration`, and local-deployment guidance. See [server security controls](security.md).

## Cache

`GET /cache` groups in-process schema state under `schemas.registered`, `schemas.validatorID`, and `schemas.referenced`; `worker_schemas` reports the union observed in validation workers. Registered schemas come from `--ref`; `validatorID` lists cached top-level schema labels; referenced schemas were fetched remotely. `outbound` reports bounded shared-cache weights and remote URL inventory. The legacy `api` object reports per-provider counts, TTL, and lifecycle timestamps without exposing API query keys.

`DELETE /cache` clears transient schema and/or API caches. Registered local schemas remain available because they are server configuration rather than cache entries.

The cache endpoints are enabled by default for compatibility with existing
local deployments. Set `BIOVALIDATOR_CACHE_ENDPOINT_ENABLED=false` at process
startup to leave both `GET /cache` and `DELETE /cache` unregistered; requests
then receive `404`.

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
| `cache.api.entries` | Total current upstream response entries, split by provider. |
| `cache.api.providers` | Per-provider cache lifecycle details. |
| `ttl_seconds` | Configured lifetime for entries in that cache. |
| `last_updated_at`, `last_cleared_at` | Last observed cache write and clear times; `null` before that event occurs. |

The schema and validation API cache lifetime defaults to 21,600 seconds (6 hours). Deployments can set `BIOVALIDATOR_CACHE_TTL_SECONDS` to a positive whole number of seconds; the effective value appears in `ttl_seconds`. Configuration is read at process startup. FEGA examples use the separate `FEGA_EXAMPLES_CACHE_TTL_SECONDS` setting, and forced refreshes are rate limited by `BIOVALIDATOR_EXAMPLES_REFRESH_MIN_INTERVAL_MS`.
| `oldest_entry_at`, `newest_entry_at` | Estimated insertion boundaries for current entries; `null` when empty. |
| `next_expiration_at` | Earliest scheduled expiration among current entries; `null` when none exists. |

Implementation-level lifecycle details are documented alongside the health and cache builders in [`server.js`](../src/core/server.js), [`biovalidator-core.js`](../src/core/biovalidator-core.js), and [`cache-metrics.js`](../src/utils/cache-metrics.js).
