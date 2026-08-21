const express = require("express");
const {logger, addLogDirectory} = require("../utils/winston");
const SecurityLimitError = require("../model/security-limit-error");
const BioValidator = require("./biovalidator-core")
const ValidationPool = require("./validation-pool");
const {FegaExamplesClient} = require("../utils/fega_examples_client");
const {loadSecurityConfig} = require("../utils/security-config");
const {SecureHttpClient} = require("../utils/secure-http-client");
const npid = require("npid");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const childProcess = require("child_process");
const packageMetadata = require("../../package.json");
const {getApiCacheDetails, clearApiCaches} = require("../keywords/shared-cache");

const PROCESS_STARTED_AT = new Date(Date.now() - (process.uptime() * 1000)).toISOString();
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const VIEW_ROOT = path.join(__dirname, "..", "views");
const CSP_NONCE_PLACEHOLDER = "__BIOVALIDATOR_CSP_NONCE__";
const SHUTDOWN_SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGUSR1"]);
const SHUTDOWN_TIMEOUT_MS = 25_000;

const JSON_STRING_ESCAPES = Object.freeze({
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "'": "\\u0027",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029"
});

/**
 * Serialize a response payload without allowing string values to become HTML
 * when a JSON response is embedded in a browser context. JSON.stringify is
 * still responsible for normal JSON escaping; this pass only escapes
 * characters that are significant to HTML/script parsers inside JSON strings.
 *
 * @param {unknown} payload plain JSON-compatible response payload.
 * @returns {string} JSON response body.
 */
function safeJsonStringify(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    return JSON.stringify({error: "Request could not be processed."});
  }

  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of serialized) {
    if (!inString) {
      result += character;
      if (character === '"') {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      // JSON.stringify emits escaped double quotes as `\"`; encode the quote
      // value without touching structural quotes around JSON strings.
      result += character === '"' ? "u0022" : character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }

    result += JSON_STRING_ESCAPES[character] || character;
  }
  return result;
}

function isPlainJsonObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sendJson(res, status, payload) {
  const responsePayload = isPlainJsonObject(payload)
    ? payload
    : {error: "Request could not be processed."};
  res.status(status)
    .type("application/json")
    .send(safeJsonStringify(responsePayload));
}

function sendError(res, status, message) {
  sendJson(res, status, {error: message});
}

function statusForError(error, fallback = 500) {
  return Number.isInteger(error && error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : fallback;
}

function describeError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch (serializationError) {
    return String(error);
  }
}

function logServerError(context, error) {
  logger.error(`${context}: ${describeError(error)}`);
}

function isCacheEndpointEnabled(environment = process.env) {
  const configured = environment.BIOVALIDATOR_CACHE_ENDPOINT_ENABLED;
  return configured === undefined || String(configured).trim().toLowerCase() !== "false";
}

/**
 * Resolve the runtime toolchain versions once for the lifetime of the process.
 * npm may be absent from a minimal runtime image, which should not prevent the
 * server from starting or make the health endpoint unavailable.
 *
 * @param {Function} [executeFileSync=childProcess.execFileSync] command runner.
 * @returns {{node: string, npm: string|null}}
 */
function resolveDependencyVersions(executeFileSync = childProcess.execFileSync) {
  let npmVersion = null;
  try {
    npmVersion = executeFileSync("npm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().replace(/^v/, "") || null;
  } catch (error) {
    npmVersion = null;
  }

  return {
    node: process.versions.node.replace(/^v/, ""),
    npm: npmVersion
  };
}

const DEPENDENCY_VERSIONS = Object.freeze(resolveDependencyVersions());

/**
 * Resolve immutable metadata for this server instance. Explicit deployment
 * values take precedence; a local checkout falls back to its current commit.
 * Failure to invoke Git is expected for packaged installations and returns a
 * null revision rather than preventing the server from starting.
 *
 * @param {string} processStartedAt ISO timestamp for the current process.
 * @param {NodeJS.ProcessEnv} [environment=process.env] environment variables.
 * @param {string} [projectRoot=PROJECT_ROOT] checkout used for Git discovery.
 * @returns {{deployedAt: string, revision: string|null}}
 */
function resolveDeploymentMetadata(
    processStartedAt,
    environment = process.env,
    projectRoot = PROJECT_ROOT
) {
  let revision = environment.BIOVALIDATOR_REVISION || null;
  if (!revision) {
    try {
      revision = childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() || null;
    } catch (error) {
      revision = null;
    }
  }

  return {
    deployedAt: environment.BIOVALIDATOR_DEPLOYED_AT || processStartedAt,
    revision
  };
}

class BioValidatorServer {
  constructor(port, localSchemaPath, options = {}) {
    this.securityConfig = options.securityConfig || loadSecurityConfig();
    this.securityProfile = options.securityProfile || (process.env.NODE_ENV === "test" ? "compatible" : "server");
    this.httpClient = options.httpClient || new SecureHttpClient({
      config: this.securityConfig,
      securityProfile: this.securityProfile
    });
    this.biovalidator = new BioValidator(localSchemaPath, {
      securityConfig: this.securityConfig,
      securityProfile: this.securityProfile,
      httpClient: this.httpClient
    });
    this.fegaExamplesClient = new FegaExamplesClient({
      securityConfig: this.securityConfig,
      httpClient: this.httpClient
    });
    this.validationPool = options.validationPool || (
      this.securityProfile === "server" && options.disableWorkers !== true && process.env.BIOVALIDATOR_DISABLE_WORKERS !== "true"
        ? new ValidationPool({localSchemaPath, securityConfig: this.securityConfig, httpClient: this.httpClient})
        : null
    );
    this.lastExamplesRefreshAt = 0;
    this.remoteRefs = [];
    this.port = port || process.env.BIOVALIDATOR_PORT || 3020;
    this.baseUrl = process.env.BIOVALIDATOR_BASE_URL || '/';
    this.logPath = process.env.BIOVALIDATOR_LOG_DIR || './logs';
    this.pidPath = process.env.BIOVALIDATOR_PID_PATH || './server.pid';
    this.cacheEndpointEnabled = isCacheEndpointEnabled(options.environment || process.env);
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    this.processExit = options.processExit || ((code) => process.exit(code));
    this.shutdownPromise = null;
    this.shutdownHandlers = new Map();
    this.uiTemplates = Object.freeze({
      index: fs.readFileSync(path.join(VIEW_ROOT, "index.html"), "utf8"),
      editing: fs.readFileSync(path.join(VIEW_ROOT, "index_editing.html"), "utf8")
    });
    this.deploymentMetadata = resolveDeploymentMetadata(PROCESS_STARTED_AT);
    this.validationMetrics = {
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        in_flight: 0
      },
      results: {
        valid: 0,
        invalid: 0
      }
    };
  }

  withBaseUrl(baseUrl) {
    this.baseUrl = baseUrl || this.baseUrl;
    return this;
  }

  withLogDir(logDir) {
    this.logPath = logDir || this.logPath;
    return this;
  }

  withPid(pidPath) {
    this.pidPath = pidPath || this.pidPath;
    return this;
  }

  withRemoteRefs(remoteRefs) {
    this.remoteRefs = Array.isArray(remoteRefs) ? remoteRefs : (remoteRefs ? [remoteRefs] : []);
    return this;
  }

  start() {
    this._configureServer()
        ._configureEndpoints();
    this.biovalidator.preloadRemoteSchemas(this.remoteRefs).then(() => {
      this._startServer()._registerHooks();
    }).catch((error) => {
      logger.error(`Failed to preload configured remote schemas: ${error.message || error}`);
      process.exitCode = 1;
    });
    return this;
  }

  _configureServer() {
    addLogDirectory(this.logPath);

    this.app = express();
    this.app.disable("x-powered-by");
    this.router = express.Router();
    this.router.get(["/", "/index.html", "/index_editing.html"], (req, res) => {
      const template = req.path === "/index_editing.html" ? this.uiTemplates.editing : this.uiTemplates.index;
      const nonce = res.locals.cspNonce;
      res.set("Cache-Control", "no-store");
      res.type("html").send(template.replaceAll(CSP_NONCE_PLACEHOLDER, nonce));
    });
    this.router.use(express.static(VIEW_ROOT, {index: false}));

    // Mount before the JSON parser so malformed POST bodies are counted too.
    this.app.use(this.baseUrl, this._trackValidationRequest.bind(this));

    this.app.use(function(req, res, next) {
      const cspNonce = crypto.randomBytes(16).toString("base64");
      res.locals.cspNonce = cspNonce;
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
      res.header("Content-Security-Policy", `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'nonce-${cspNonce}'`);
      res.header("Cross-Origin-Opener-Policy", "same-origin");
      res.header("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
      res.header("Referrer-Policy", "no-referrer");
      res.header("X-Content-Type-Options", "nosniff");
      res.header("X-Frame-Options", "DENY");
      next();
    });

    this.app.use(express.json({limit: this.securityConfig.requestMaxBytes, strict: true}));

    this.app.use((err, req, res, next) => {
      if (err && err.type === "entity.too.large") {
        const limitError = new SecurityLimitError(
          `The request body exceeded this Biovalidator deployment's ${this.securityConfig.requestMaxBytes}-byte limit.`,
          {
            code: "REQUEST_BODY_SIZE_LIMIT",
            status: 413,
            configuration: "BIOVALIDATOR_REQUEST_MAX_BYTES",
            limit: {name: "request_max_bytes", configured: this.securityConfig.requestMaxBytes,
              observed: Number(req.headers["content-length"]) || undefined, unit: "bytes"}
          }
        );
        sendJson(res, 413, limitError.toJSON());
      } else if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        logger.info("Received malformed JSON.");
        sendError(res, 400, "Received malformed JSON.");
      } else {
        logServerError("Unhandled request error", err);
        sendError(res, statusForError(err), "Request could not be processed.");
      }
    });

    this.app.use(this.baseUrl, this.router);
    return this;
  }

  /**
   * Track POST /validate requests for the lifetime of this process. A request
   * is successful when its HTTP response is 2xx; valid/invalid counts describe
   * validation outcomes and therefore only advance for processed responses.
   * The request invariant is total = successful + failed + in_flight.
   */
  _trackValidationRequest(req, res, next) {
    if (req.method !== "POST" || !/^\/validate\/?$/.test(req.path)) {
      next();
      return;
    }

    const requests = this.validationMetrics.requests;
    requests.total += 1;
    requests.in_flight += 1;
    let finalized = false;

    const finalize = (aborted) => {
      if (finalized) {
        return;
      }
      finalized = true;
      requests.in_flight = Math.max(0, requests.in_flight - 1);

      if (aborted || res.statusCode < 200 || res.statusCode >= 300) {
        requests.failed += 1;
        return;
      }

      requests.successful += 1;
      if (res.locals.validationResult === "valid") {
        this.validationMetrics.results.valid += 1;
      } else if (res.locals.validationResult === "invalid") {
        this.validationMetrics.results.invalid += 1;
      }
    };

    res.once("finish", () => finalize(false));
    res.once("close", () => finalize(!res.writableEnded));
    next();
  }

  _configureEndpoints() {
    this.router.post("/validate", (req, res) => {
      let startTime = new Date().getTime();
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        sendError(res, 400, "Malformed data. The request body must be a JSON object.");
        return;
      }
      let inputSchema = req.body.schema;
      let inputObject = req.body.data;

      const hasSchema = Object.prototype.hasOwnProperty.call(req.body, "schema");
      const hasData = Object.prototype.hasOwnProperty.call(req.body, "data");

      if (hasSchema && hasData) {
        const executor = this.validationPool || this.biovalidator;
        executor.validate(inputSchema, inputObject).then((output) => {
          res.locals.validationResult = output.length === 0 ? "valid" : "invalid";
          res.status(200).send(output);
          logger.info("New validation request: Processed successfully in " + (new Date().getTime() - startTime) + "ms.");
        }).catch((error) => {
          const status = statusForError(error);
          logServerError("New validation request: Server failed to process data", error);
          if (error instanceof SecurityLimitError) {
            sendJson(res, status, error.toJSON());
          } else {
            sendError(res, status, "Validation failed. See server logs for details.");
          }
        });
      } else {
        const message = "Malformed data. Please provide both 'schema' and 'data' in request body.";
        sendError(res, 400, message);
        logger.info("New validation request: " + message);
      }
    });

    this.router.get("/validate", (req, res) => {
      res.send({
        message: "EGA Biovalidator endpoint: Please use POST method to validate FEGA/EGA metadata JSON against " +
            "a JSON Schema. See Example POST message structure 'example_post_body'. For more information about " +
            "Biovalidator see https://github.com/elixir-europe/biovalidator and for FEGA schemas see " +
            "https://github.com/EGA-archive/fega-metadata-schema",
        example_post_body: {
          schema: {
            "$ref": "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/cohort/schema.json"
          },
          data: {
            "@context": "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/cohort/schema.json",
            "@type": "ega:cohort",
            "id": "ega:EGAH00000000001",
            "name": "Barcelona adult genomics cohort",
            "cohortType": "study-defined"
          }
        }
      });
    });

    this.router.get("/examples", (req, res) => {
      if (req.query.refresh === "true") {
        const now = Date.now();
        const elapsed = now - this.lastExamplesRefreshAt;
        if (elapsed < this.securityConfig.examplesRefreshMinIntervalMs) {
          const retryAfterSeconds = Math.max(1, Math.ceil(
            (this.securityConfig.examplesRefreshMinIntervalMs - elapsed) / 1000
          ));
          const error = new SecurityLimitError(
            `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} before refreshing the FEGA examples.`,
            {
              code: "EXAMPLES_REFRESH_RATE_LIMIT",
              status: 429,
              configuration: "BIOVALIDATOR_EXAMPLES_REFRESH_MIN_INTERVAL_MS",
              retryAfterSeconds
            }
          );
          res.set("Retry-After", String(retryAfterSeconds));
          sendJson(res, error.status, error.toJSON());
          return;
        }
        this.lastExamplesRefreshAt = now;
      }
      const examplesPromise = req.query.refresh === "true"
        ? this.fegaExamplesClient.refreshExamples()
        : this.fegaExamplesClient.getExamples();
      examplesPromise.then((examples) => {
        res.status(200).send(examples);
      }).catch((error) => {
        if (error instanceof SecurityLimitError) {
          logServerError("Failed to load FEGA examples", error);
          sendJson(res, error.status, error.toJSON());
          return;
        }
        logServerError("Failed to load FEGA examples", error);
        sendError(res, 502, "Failed to load FEGA examples.");
      });
    });

    if (this.cacheEndpointEnabled) {
      this.router.get("/cache", (req, res) => {
        res.send({
          schemas: this.biovalidator.getSchemaInventory(),
          worker_schemas: this.validationPool ? this.validationPool.getSchemaInventory() : undefined,
          api: getApiCacheDetails(),
          outbound: this.httpClient.snapshot()
        });
      });

      this.router.delete("/cache", (req, res) => {
        const scope = req.query.scope === undefined ? "all" : req.query.scope;
        const validScopes = new Set(["all", "schemas", "api"]);
        if (typeof scope !== "string" || !validScopes.has(scope)) {
          sendError(res, 400, "Invalid cache scope. Expected one of: all, schemas, api.");
          return;
        }

        const cleared = [];
        if (scope === "all" || scope === "schemas") {
          this.biovalidator.clearSchemaCaches();
          if (this.validationPool) {
            this.validationPool.clearSchemaCaches();
          }
          this.httpClient.clear("schemas");
          cleared.push("schemas");
        }
        if (scope === "all" || scope === "api") {
          clearApiCaches();
          this.httpClient.clear("api");
          cleared.push("api");
        }

        res.send({
          message: "Cache cleared successfully",
          scope,
          cleared
        });
      });
    }

    this.router.get("/health", (req, res) => {
      res.status(200).send(this._getHealthDetails());
    });

    return this;
  }

  /**
   * Build the process-local health snapshot. `status` is a liveness signal and
   * does not probe OLS, ENA Taxonomy, identifiers.org, or other dependencies.
   * Counters and cache history reset on process restart. Cache timestamps are
   * null until the corresponding event occurs or while no current entry can
   * supply an insertion/expiration boundary.
   *
   * @returns {object} Current process, deployment, validation, and cache data.
   */
  _getHealthDetails() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: packageMetadata.version,
      uptime_seconds: process.uptime(),
      process_started_at: PROCESS_STARTED_AT,
      deployed_at: this.deploymentMetadata.deployedAt,
      revision: this.deploymentMetadata.revision,
      dependency_versions: DEPENDENCY_VERSIONS,
      validation: {
        requests: {...this.validationMetrics.requests},
        results: {...this.validationMetrics.results}
      },
      cache: {
        schemas: this.biovalidator.getSchemaCacheDetails(),
        api: getApiCacheDetails(),
        outbound: this.httpClient.snapshot()
      },
      validation_capacity: this.validationPool ? this.validationPool.getDetails() : null
    };
  }

  _startServer() {
    this.expressServer = this.app.listen(this.port, () => {
      logger.info(`---------------------------------------------`);
      logger.info(`------------ ELIXIR biovalidator ------------`);
      logger.info(`---------------------------------------------`);
      logger.info(`Started server on port ${this.port} with base URL ${this.baseUrl}`);
      logger.info(`Server available at http://localhost:${this.port + this.baseUrl}`);
      logger.info(`PID file is available at ${path.resolve(this.pidPath)}`);
      logger.info(`Writing logs to: ${path.resolve(this.logPath)}/`);
    });

    return this;
  }

  _registerHooks() {
    try {
      npid.create(this.pidPath).removeOnExit();
    } catch(err) {
      logger.error("Failed to create PID file. ", err);
      logger.warn(`Please check if another instance of the server is running or else delete the PID file available at ${this.pidPath} before starting the server`)
      // In test environments we should not crash the process; tests may start multiple servers
      if (process.env.NODE_ENV === 'test') {
        logger.warn("Running under test environment: PID creation failed but continuing without exiting.");
      } else {
        process.exit(1);
      }
    }

    for (const signal of SHUTDOWN_SIGNALS) {
      const handler = () => this.shutdown(signal);
      this.shutdownHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  _removeShutdownHooks() {
    for (const [signal, handler] of this.shutdownHandlers) {
      process.removeListener(signal, handler);
    }
    this.shutdownHandlers.clear();
  }

  _removePidFile() {
    try {
      npid.remove(this.pidPath);
    } catch (error) {
      logger.warn(`Failed to remove PID file at ${this.pidPath}: ${error.message || error}`);
    }
  }

  shutdown(signal) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    logger.info(`Received ${signal}; shutting down Biovalidator.`);

    const closeHttpServer = new Promise((resolve, reject) => {
      if (!this.expressServer) {
        resolve();
        return;
      }
      try {
        this.expressServer.close((error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });

    const closeValidationPool = this.validationPool
      ? Promise.resolve().then(() => this.validationPool.close())
      : Promise.resolve();

    this.shutdownPromise = new Promise((resolve) => {
      let completed = false;
      const finish = (exitCode, error) => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(forceTimer);
        this._removeShutdownHooks();
        this._removePidFile();
        if (error) {
          logger.error(`Biovalidator shutdown failed: ${error.message || error}`);
        } else {
          logger.info("Biovalidator shutdown completed.");
        }
        this.processExit(exitCode);
        resolve(exitCode);
      };

      const forceTimer = setTimeout(() => {
        finish(1, new Error(`Shutdown exceeded ${this.shutdownTimeoutMs}ms; forcing exit.`));
      }, this.shutdownTimeoutMs);

      Promise.all([closeHttpServer, closeValidationPool])
        .then(() => finish(0))
        .catch((error) => finish(1, error));
    });

    return this.shutdownPromise;
  }
}

module.exports = BioValidatorServer;
module.exports.resolveDeploymentMetadata = resolveDeploymentMetadata;
module.exports.resolveDependencyVersions = resolveDependencyVersions;
module.exports.isCacheEndpointEnabled = isCacheEndpointEnabled;
module.exports.SHUTDOWN_SIGNALS = SHUTDOWN_SIGNALS;
module.exports.SHUTDOWN_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS;
