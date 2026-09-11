const Ajv = require("ajv").default;
const {AsyncLocalStorage} = require("async_hooks");
const Ajv2019 = require("ajv/dist/2019");
const Ajv2020 = require("ajv/dist/2020");
const draft06MetaSchema = require("ajv/dist/refs/json-schema-draft-06.json");
const draft07MetaSchema = require("ajv/dist/refs/json-schema-draft-07.json");
const addFormats = require("ajv-formats");
const axios = require('axios');
const traverse = require("json-schema-traverse");
const {getFiles, readFile} = require("../utils/file_utils");
const {isChildTermOf, isValidTerm, isValidTaxonomy} = require("../keywords");
const GraphRestriction = require("../keywords/graphRestriction");
const IsValidIdentifier = require("../keywords/isvalididentifier");
const ValidationError = require("../model/validation-error");
const {logger} = require("../utils/winston");
const NodeCache = require("node-cache");
const constants = require("../utils/constants");
const {CacheMetrics, aggregateCacheSnapshots} = require("../utils/cache-metrics");
const {
    CACHE_TTL_SECONDS,
    CACHE_CHECK_PERIOD_SECONDS
} = require("../utils/cache-config");
const SecurityLimitError = require("../model/security-limit-error");
const {loadSecurityConfig} = require("../utils/security-config");
const {SecureHttpClient, approximateBytes} = require("../utils/secure-http-client");
const {cloneJson, digestJson, findAjvDataReference, inspectJsonComplexity} = require("../utils/json-security");

class BioValidator {
    constructor(localSchemaPath, options = {}) {
        // Maintain separate AJV contexts per draft family to avoid mixing incompatible drafts
        // '07' handles draft-06/07, '2019' handles draft-2019-09
        // '2020' will handle draft-2020-12
        this.ajvContexts = {};
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.httpClient = options.httpClient || new SecureHttpClient({
            config: this.securityConfig,
            adapter: options.adapter || axios
        });
        this.authoritativeSchemaIds = new Map();
        this.validationStorage = new AsyncLocalStorage();
        this.customKeywordValidators = [
            new isChildTermOf(null, constants.OLS_SEARCH_URL, this._httpOptions()),
            new isValidTerm(null, constants.OLS_SEARCH_URL, this._httpOptions()),
            new isValidTaxonomy(null, this._httpOptions()),
            new GraphRestriction(null, constants.OLS_SEARCH_URL, this._httpOptions()),
            new IsValidIdentifier(this._httpOptions())
        ];
        this._initAjvContexts(localSchemaPath);
    }

    _httpOptions() {
        return {
            securityConfig: this.securityConfig,
            httpClient: this.httpClient
        };
    }

    async validate(inputSchema, inputObject) {
        const schema = this._prepareInputSchema(inputSchema);
        return this.validationStorage.run({remoteUris: new Set(), remoteBytes: 0}, async () => {
            const errors = await this._validate(schema, inputObject);
            if (errors.length > this.securityConfig.validationMaxErrors) {
                throw new SecurityLimitError("Validation produced too many errors for this deployment.", {
                    code: "VALIDATION_ERROR_LIMIT", configuration: "BIOVALIDATOR_VALIDATION_MAX_ERRORS"
                });
            }
            const result = this.convertToValidationErrors(errors);
            if (Buffer.byteLength(JSON.stringify(result)) > this.securityConfig.validationResultMaxBytes) {
                throw new SecurityLimitError("Validation results exceeded this deployment's response limit.", {
                    code: "VALIDATION_RESULT_SIZE_LIMIT", configuration: "BIOVALIDATOR_VALIDATION_RESULT_MAX_BYTES"
                });
            }
            return result;
        });
    }

    _prepareInputSchema(inputSchema) {
        const validSchemaShape = typeof inputSchema === "boolean" ||
            (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema));
        if (!validSchemaShape) {
            throw new SecurityLimitError("Biovalidator requires 'schema' to be a JSON Schema object or boolean.", {
                code: "SCHEMA_TYPE_INVALID",
                status: 400
            });
        }
        inspectJsonComplexity(inputSchema, {
            maxDepth: this.securityConfig.schemaMaxDepth,
            maxValues: this.securityConfig.schemaMaxValues,
            depthCode: "SCHEMA_DEPTH_LIMIT",
            valueCode: "SCHEMA_VALUE_LIMIT",
            depthName: "schema_max_depth",
            valueName: "schema_max_values",
            depthConfiguration: "BIOVALIDATOR_SCHEMA_MAX_DEPTH",
            valueConfiguration: "BIOVALIDATOR_SCHEMA_MAX_VALUES"
        });
        const cloned = cloneJson(inputSchema);
        if (findAjvDataReference(cloned)) {
            throw new SecurityLimitError(
                "This Biovalidator server does not permit AJV $data expressions in untrusted schemas.",
                {code: "SCHEMA_DATA_REFERENCE_DENIED", configuration: "strict runtime policy"}
            );
        }
        if (cloned && typeof cloned === "object" && typeof cloned.$id === "string") {
            const authoritative = this.authoritativeSchemaIds.get(cloned.$id);
            if (authoritative && authoritative.digest !== digestJson(cloned)) {
                throw new SecurityLimitError(
                    `The submitted schema declares authoritative $id '${cloned.$id}' but its content does not match ` +
                    `the ${authoritative.source} schema reserved by this Biovalidator deployment.`,
                    {code: "SCHEMA_ID_CONTENT_COLLISION", status: 422}
                );
            }
        }
        return cloned;
    }

    /**
     * Inventory schema configuration and transient caches across AJV contexts.
     * Registered schemas come from --ref and persist for the server lifetime;
     * validator IDs and referenced schemas are expiring runtime caches.
     */
    getSchemaInventory() {
        const registered = [];
        const validatorIDs = [];
        const referenced = [];

        for (const context of Object.values(this.ajvContexts)) {
            registered.push(...context.registeredSchemas.keys());
            for (const key of context.validatorCache.keys()) {
                validatorIDs.push(context.validatorMetadata.get(key) || key);
            }
            referenced.push(...context.referencedSchemaCache.keys());
        }

        return {
            registered: [...new Set(registered)].sort(),
            validatorID: [...new Set(validatorIDs)].sort(),
            referenced: [...new Set(referenced)].sort()
        };
    }

    /**
     * Clear transient schema caches without removing --ref registrations.
     */
    clearSchemaCaches() {
        logger.info("Clearing compiled validator and remote reference caches.");
        // AJV may register a remotely loaded schema in the context that
        // requested it as well as in the context selected by its $schema.
        // Track every transient URI/alias first, then remove those IDs from
        // every AJV context. Otherwise a cross-draft compilation can reuse a
        // schema that is no longer present in referencedSchemaCache.
        const transientSchemaIds = new Set();
        const remoteMetadata = new Set();
        for (const context of Object.values(this.ajvContexts)) {
            for (const schemaId of context.referencedSchemaCache.keys()) {
                transientSchemaIds.add(schemaId);
                const metadata = context.referencedSchemaMetadata.get(schemaId);
                if (metadata) {
                    remoteMetadata.add(metadata);
                    for (const alias of metadata.ajvAliases || []) {
                        transientSchemaIds.add(alias);
                    }
                }
            }
        }

        for (const metadata of remoteMetadata) {
            this._releaseRemoteSchemaMetadata(metadata);
        }

        for (const context of Object.values(this.ajvContexts)) {
            for (const schemaId of transientSchemaIds) {
                try {
                    context.ajv.removeSchema(schemaId);
                } catch (error) {
                    logger.warn(`Failed to remove transient schema '${schemaId}' from AJV context ${context.type}: ${error.message || error}`);
                }
            }
            context.validatorCache.flushAll();
            context.referencedSchemaCache.flushAll();
            context.referencedSchemaMetadata.clear();
            context.validatorMetadata.clear();
        }
    }

    /**
     * Summarize compiled-validator and referenced-schema caches across all AJV
     * draft contexts. Counts include only current entries; lifecycle timestamps
     * follow the CacheMetrics semantics documented in utils/cache-metrics.js.
     */
    getSchemaCacheDetails() {
        const compiledSnapshots = [];
        const referencedSnapshots = [];

        for (const context of Object.values(this.ajvContexts)) {
            compiledSnapshots.push(context.validatorCacheMetrics.snapshot());
            referencedSnapshots.push(context.referencedSchemaCacheMetrics.snapshot());
        }

        const allSnapshots = compiledSnapshots.concat(referencedSnapshots);
        const aggregate = aggregateCacheSnapshots(allSnapshots, CACHE_TTL_SECONDS);
        const compiled = compiledSnapshots.reduce((total, snapshot) => total + snapshot.entries, 0);
        const referenced = referencedSnapshots.reduce((total, snapshot) => total + snapshot.entries, 0);

        return {
            ttl_seconds: aggregate.ttl_seconds,
            entries: {
                total: compiled + referenced,
                compiled,
                referenced
            },
            last_updated_at: aggregate.last_updated_at,
            last_cleared_at: aggregate.last_cleared_at,
            oldest_entry_at: aggregate.oldest_entry_at,
            newest_entry_at: aggregate.newest_entry_at,
            next_expiration_at: aggregate.next_expiration_at
        };
    }

    // AJV requires $async keyword in schemas if they use any of async custom defined keywords.
    // We populate all schemas/defs with $async as a workaround to avoid users manually entering $async in schemas.
    _insertAsyncToSchemasAndDefs(inputSchema) {
        if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
            return;
        }
        const schemaIdForLog = inputSchema.$id || "[no '$id' at root]"; // Use for logging
        // If it's the known meta-schema ID, skip adding $async
        if (
            typeof inputSchema.$id === "string" &&
            (
                inputSchema.$id.startsWith("http://json-schema.org/draft") ||
                inputSchema.$id.startsWith("https://json-schema.org/draft")
            )
        ) {
            logger.debug(`Skipping "$async" injection for official meta-schema '$id': '${schemaIdForLog}'`);
            return;
        }

        if (!Object.prototype.hasOwnProperty.call(inputSchema, "$async")) {
            inputSchema["$async"] = true;
            logger.debug(`Auto-injected "$async": true at root for schema '$id': '${schemaIdForLog}'`);
        } else if (inputSchema.$async === true) {
            logger.debug(`Root already has "$async": '${inputSchema["$async"]}' for schema '$id': '${schemaIdForLog}'`);
        } else if (inputSchema.$async === false) {
            logger.debug(`Root already has "$async": '${inputSchema["$async"]}' ('$async' injection will be skipped for definitions) for schema '$id': '${schemaIdForLog}'`);
            return; // Don't inject if explicitly false
        }

        if (this._draftType(inputSchema) === "07") {
            traverse(inputSchema, node => {
                if (typeof node.$ref === "string") { delete node.type; delete node.nullable; }
            });
        }
        // Also inject into definitions/$defs if root $async is true (or missing)
        if (Object.prototype.hasOwnProperty.call(inputSchema, "definitions")) {
            let defs = Object.keys(inputSchema.definitions);
            for (let x = 0; x < defs.length; x++) {
                if (typeof inputSchema.definitions[defs[x]] === 'object' && inputSchema.definitions[defs[x]] !== null) {
                     inputSchema.definitions[defs[x]]["$async"] = true;
                }
            }
        } else if (Object.prototype.hasOwnProperty.call(inputSchema, "$defs")) { // support draft‑2019/2020 keyword ($defs)
             for (const k of Object.keys(inputSchema.$defs)) {
                if (typeof inputSchema.$defs[k] === 'object' && inputSchema.$defs[k] !== null) {
                    inputSchema.$defs[k]["$async"] = true;
                }
             }
        }
    }

    async _resolveInputDraft(inputSchema) {
        if (!inputSchema || typeof inputSchema !== "object" || inputSchema.$schema ||
            typeof inputSchema.$ref !== "string" || inputSchema.$ref.startsWith("#")) return;
        const registered = Object.values(this.ajvContexts).some(ctx => ctx.registeredSchemas.has(inputSchema.$ref));
        if (registered) return;
        const uri = inputSchema.$ref.split("#")[0];
        const remote = await this.ajvContexts["2019"].loadSchema(uri);
        if (remote && typeof remote.$schema === "string") inputSchema.$schema = remote.$schema;
    }

    async _validate(inputSchema, inputObject) {
        await this._resolveInputDraft(inputSchema);
        this._insertAsyncToSchemasAndDefs(inputSchema);
        let validate;
        try {
            validate = await this.getValidationFunction(inputSchema);
        } catch (error) {
            if (error instanceof SecurityLimitError) throw error;
            throw new SecurityLimitError(`Invalid schema: ${error.message || error}`, {
                code: "SCHEMA_COMPILATION_FAILED", status: 422,
                help: "Correct the schema or configure its annotation keywords before retrying."
            });
        }
        try {
            await validate(inputObject);
            return validate.errors || [];
        } catch (error) {
            if (error instanceof Ajv.ValidationError) return error.errors;
            throw error;
        }
    }

    convertToValidationErrors(ajvErrorObjects) {
        const grouped = new Map();
        for (const error of ajvErrorObjects) {
            const item = new ValidationError(error);
            if (grouped.has(item.dataPath)) grouped.get(item.dataPath).errors.push(...item.errors);
            else grouped.set(item.dataPath, item);
        }
        return [...grouped.values()];
    }

    getValidationFunction(inputSchema) {
        const ctx = this._getAjvContextForSchema(inputSchema);
        if (ctx.type === "07" && inputSchema && typeof inputSchema === "object") {
            // Ajv checks type before its legacy ignoreKeywordsWithRef branch.
            // Strip that pre-check only at schema nodes, never inside enum/default data.
            inputSchema = cloneJson(inputSchema);
            traverse(inputSchema, node => {
                if (typeof node.$ref === "string") {
                    delete node.type;
                    delete node.nullable;
                }
            });
        }
        const schemaId = inputSchema && typeof inputSchema === "object" ? inputSchema.$id : undefined;
        if (schemaId && ctx.registeredSchemas.has(schemaId)) {
            const wrapper = {$async: true, $ref: schemaId};
            return ctx.createCompiler().compileAsync(wrapper);
        }
        const schemaDigest = digestJson(inputSchema);
        const cacheKey = `${ctx.type}:${schemaDigest}`;
        if (ctx.validatorCache.has(cacheKey)) {
            const metadata = ctx.validatorMetadata.get(cacheKey);
            ctx.validatorMetadata.delete(cacheKey);
            ctx.validatorMetadata.set(cacheKey, metadata);
            return Promise.resolve(ctx.validatorCache.get(cacheKey));
        }
        // NodeCache limits entries but does not evict. Reserve a slot before compiling.
        while (ctx.validatorCache.keys().length >= this.securityConfig.compiledCacheMaxEntries) {
            const oldest = ctx.validatorMetadata.keys().next().value || ctx.validatorCache.keys()[0];
            ctx.validatorCache.del(oldest);
        }
        // Each compilation owns its registry, including nested IDs and anchors.
        // Only completed/in-flight compiled validators enter the bounded cache.
        const compiled = ctx.createCompiler().compileAsync(inputSchema);
        ctx.validatorCache.set(cacheKey, compiled);
        ctx.validatorMetadata.set(cacheKey, schemaId || `(content:${schemaDigest.slice(0, 12)})`);
        compiled.catch(() => {
            if (ctx.validatorCache.get(cacheKey) === compiled) ctx.validatorCache.del(cacheKey);
        });
        return compiled;
    }

    async preloadRemoteSchemas(urls = []) {
        for (const url of urls) {
            const schema = this._prepareInputSchema({$ref: url});
            this._insertAsyncToSchemasAndDefs(schema);
            await this.validationStorage.run({remoteUris: new Set(), remoteBytes: 0}, async () => {
                await this._resolveInputDraft(schema);
                return this.getValidationFunction(schema);
            });
        }
    }

    _releaseRemoteSchemaMetadata(metadata) {
        if (!metadata || !Array.isArray(metadata.authoritativeIds)) {
            return;
        }
        for (const id of metadata.authoritativeIds) {
            const reservation = this.authoritativeSchemaIds.get(id);
            if (reservation && reservation.source === "remote" && reservation.digest === metadata.digest) {
                this.authoritativeSchemaIds.delete(id);
            }
        }
    }

    _chargeRemoteSchemaBudget(uri, observedBytes) {
        const requestBudget = this.validationStorage.getStore();
        if (!requestBudget || requestBudget.remoteUris.has(uri)) {
            return;
        }
        requestBudget.remoteUris.add(uri);
        requestBudget.remoteBytes += observedBytes;
        if (requestBudget.remoteUris.size > this.securityConfig.remoteDocumentMax) {
            throw new SecurityLimitError(
                `This validation required more than ${this.securityConfig.remoteDocumentMax} remote schema documents.`,
                {
                    code: "REMOTE_SCHEMA_DOCUMENT_LIMIT",
                    status: 422,
                    configuration: "BIOVALIDATOR_REMOTE_DOCUMENT_MAX",
                    limit: {name: "remote_document_max", configured: this.securityConfig.remoteDocumentMax,
                        observed: requestBudget.remoteUris.size, unit: "documents"}
                }
            );
        }
        if (requestBudget.remoteBytes > this.securityConfig.remoteSchemaTotalBytes) {
            throw new SecurityLimitError(
                `Remote schemas for this validation exceeded this Biovalidator deployment's ` +
                `${this.securityConfig.remoteSchemaTotalBytes}-byte aggregate limit.`,
                {
                    code: "REMOTE_SCHEMA_TOTAL_SIZE_LIMIT",
                    status: 422,
                    configuration: "BIOVALIDATOR_REMOTE_SCHEMA_TOTAL_BYTES",
                    limit: {name: "remote_schema_total_bytes", configured: this.securityConfig.remoteSchemaTotalBytes,
                        observed: requestBudget.remoteBytes, unit: "bytes"}
                }
            );
        }
    }

    /**
     * Initialize AJV contexts for different draft families.
     * - '07' handles draft-06/07; '2019' handles draft-2019-09
     * - '2020' handles draft-2020-12
     * Each context has its own AJV instance and separate caches to avoid cross-draft contamination.
     */ 
    _initAjvContexts(localSchemaPath) {
        const localSchemas = this._loadLocalSchemas(localSchemaPath);
        this.ajvContexts['07'] = this._createAjvContext('07', localSchemas);
        this.ajvContexts['2019'] = this._createAjvContext('2019', localSchemas);
        this.ajvContexts['2020'] = this._createAjvContext('2020', localSchemas);
    }

    /**
     * Read and validate --ref configuration once before creating AJV contexts.
     * Every local reference needs a unique, non-empty $id so AJV can resolve it.
     */
    _loadLocalSchemas(localSchemaPath) {
        if (!localSchemaPath) {
            return [];
        }

        let schemaFiles;
        try {
            schemaFiles = Array.from(getFiles(localSchemaPath));
        } catch (error) {
            throw new Error(`Failed to resolve local reference schemas '${localSchemaPath}': ${error.message || error}`);
        }

        const seenIds = new Map();
        return schemaFiles.map((file) => {
            let schema;
            try {
                schema = readFile(file);
            } catch (error) {
                throw new Error(`Failed to read local reference schema '${file}': ${error.message || error}`);
            }

            if (typeof schema.$id !== "string" || schema.$id.trim() === "") {
                throw new Error(`Local reference schema '${file}' must define a non-empty $id.`);
            }
            if (seenIds.has(schema.$id)) {
                throw new Error(`Duplicate local reference schema $id '${schema.$id}' in '${seenIds.get(schema.$id)}' and '${file}'.`);
            }
            seenIds.set(schema.$id, file);
            const schemaDigest = digestJson(schema);
            this.authoritativeSchemaIds.set(schema.$id, {
                digest: schemaDigest,
                source: "local"
            });

            return {
                file,
                schema,
                digest: schemaDigest,
                type: this._draftType(schema)
            };
        });
    }

    /**
     * Create an AJV context for a given draft family.
     * Context holds:
     * - ajv: AJV instance (Ajv2019 or Ajv2020)
     * - referencedSchemaCache: cache for schemas loaded via $ref
     * - validatorCache: cache for compiled schema functions
     */
    _createAjvContext(type, localSchemas) {
        const referencedSchemaCache = new NodeCache({
            stdTTL: CACHE_TTL_SECONDS,
            checkperiod: CACHE_CHECK_PERIOD_SECONDS,
            useClones: false,
            maxKeys: this.securityConfig.remoteSchemaCacheMaxEntries
        });
        const validatorCache = new NodeCache({
            stdTTL: CACHE_TTL_SECONDS,
            checkperiod: CACHE_CHECK_PERIOD_SECONDS,
            useClones: false,
            maxKeys: this.securityConfig.compiledCacheMaxEntries
        });
        const validatorMetadata = new Map();
        const referencedSchemaMetadata = new Map();
        const referencedSchemaCacheMetrics = new CacheMetrics(referencedSchemaCache, CACHE_TTL_SECONDS);
        const validatorCacheMetrics = new CacheMetrics(validatorCache, CACHE_TTL_SECONDS);

        for (const local of localSchemas.filter(candidate => candidate.type === type)) {
            this._insertAsyncToSchemasAndDefs(local.schema);
        }
        const AjvClass = type === '07' ? Ajv : (type === '2020' ? Ajv2020 : Ajv2019);

        // loader bound to this context's referencedSchemaCache
        const loadSchema = (uri) => {
            logger.debug(`AJV requesting schema load (context: ${type}) for URI: ${uri}`);
            const local = localSchemas.find(candidate =>
                candidate.schema.$id.replace(/#$/, "") === uri.replace(/#$/, ""));
            if (local) return Promise.resolve(cloneJson(local.schema));
            // skip if it's an official meta-schema
            if (
                uri.startsWith("http://json-schema.org/draft") ||
                uri.startsWith("https://json-schema.org/draft")
            ) {
                logger.debug(`Skipping official meta-schema fetch: ${uri}`);
                return Promise.resolve({});
            }

            // Check this context's cache first
            if (referencedSchemaCache.has(uri)) {
                logger.debug("Returning referenced schema from reference cache: " + uri);
                this._chargeRemoteSchemaBudget(uri,
                    referencedSchemaMetadata.get(uri)?.bytes || approximateBytes(referencedSchemaCache.get(uri)));
                return Promise.resolve(cloneJson(referencedSchemaCache.get(uri)));
            }

            // Check other AJV contexts' caches to avoid unnecessary network fetches
            for (const ctxKey of Object.keys(this.ajvContexts)) {
                const otherCtx = this.ajvContexts[ctxKey];
                if (otherCtx && otherCtx.referencedSchemaCache && otherCtx.referencedSchemaCache.has(uri)) {
                    logger.debug(`Returning referenced schema from reference cache (context: ${ctxKey}): ${uri}`);
                    this._chargeRemoteSchemaBudget(uri,
                        otherCtx.referencedSchemaMetadata.get(uri)?.bytes || approximateBytes(otherCtx.referencedSchemaCache.get(uri)));
                    return Promise.resolve(cloneJson(otherCtx.referencedSchemaCache.get(uri)));
                }
            }

            // Not in any cache; fetch from the bounded, allowlisted HTTP client.
            logger.debug(`Fetching referenced schema from network: ${uri}`);
            return this.httpClient.getJson(uri, {
                kind: "remoteSchema",
                maxBytes: this.securityConfig.remoteSchemaMaxBytes,
                cache: true
            }).then(async resp => {
                        const loadedSchema = cloneJson(resp.data);
                        const validSchemaShape = typeof loadedSchema === "boolean" ||
                            (loadedSchema && typeof loadedSchema === "object" && !Array.isArray(loadedSchema));
                        if (!validSchemaShape) {
                            throw new SecurityLimitError(
                                `Remote $ref '${uri}' did not return a JSON Schema object or boolean.`,
                                {code: "REMOTE_SCHEMA_TYPE_INVALID", status: 502}
                            );
                        }
                        inspectJsonComplexity(loadedSchema, {
                            maxDepth: this.securityConfig.schemaMaxDepth,
                            maxValues: this.securityConfig.schemaMaxValues,
                            depthCode: "REMOTE_SCHEMA_DEPTH_LIMIT",
                            valueCode: "REMOTE_SCHEMA_VALUE_LIMIT",
                            depthName: "remote_schema_max_depth",
                            valueName: "remote_schema_max_values",
                            depthConfiguration: "BIOVALIDATOR_SCHEMA_MAX_DEPTH",
                            valueConfiguration: "BIOVALIDATOR_SCHEMA_MAX_VALUES"
                        });
                        if (findAjvDataReference(loadedSchema)) {
                            throw new SecurityLimitError(
                                `Remote $ref '${uri}' contains AJV $data expressions, which this Biovalidator server does not permit.`,
                                {code: "REMOTE_SCHEMA_DATA_REFERENCE_DENIED", status: 502}
                            );
                        }

                        const observedBytes = resp.sizeBytes || approximateBytes(resp.data);
                        this._chargeRemoteSchemaBudget(uri, observedBytes);

                        const loadedDigest = digestJson(resp.data);
                        const claimedIds = [new URL(uri).toString()];
                        const ajvAliases = [...claimedIds];
                        const declaredId = loadedSchema && typeof loadedSchema === "object" &&
                            typeof loadedSchema.$id === "string" ? loadedSchema.$id : null;
                        if (declaredId) {
                            const resolvedDeclaredId = new URL(declaredId, uri).toString();
                            ajvAliases.push(resolvedDeclaredId);
                            const reservedDeclaration = this.authoritativeSchemaIds.get(resolvedDeclaredId);
                            if (reservedDeclaration && reservedDeclaration.digest !== loadedDigest) {
                                throw new SecurityLimitError(
                                    `Remote schema '${uri}' conflicts with the ${reservedDeclaration.source} schema reserved as '${resolvedDeclaredId}'.`,
                                    {code: "REMOTE_SCHEMA_ID_CONTENT_COLLISION", status: 502}
                                );
                            }
                            if (resolvedDeclaredId !== new URL(uri).toString()) {
                                const canonicalResponse = await this.httpClient.getJson(resolvedDeclaredId, {
                                    kind: "remoteSchema",
                                    maxBytes: this.securityConfig.remoteSchemaMaxBytes,
                                    cache: true
                                });
                                const canonicalBytes = canonicalResponse.sizeBytes || approximateBytes(canonicalResponse.data);
                                this._chargeRemoteSchemaBudget(resolvedDeclaredId, canonicalBytes);
                                if (digestJson(canonicalResponse.data) !== loadedDigest) {
                                    throw new SecurityLimitError(
                                        `Remote schema '${uri}' declares $id '${resolvedDeclaredId}', but that authoritative URL serves different content.`,
                                        {code: "REMOTE_SCHEMA_ID_CONTENT_COLLISION", status: 502}
                                    );
                                }
                                claimedIds.push(resolvedDeclaredId);
                            } else if (resolvedDeclaredId === new URL(uri).toString()) {
                                claimedIds.push(resolvedDeclaredId);
                            }
                        }
                        for (const claimedId of new Set(claimedIds)) {
                            const reserved = this.authoritativeSchemaIds.get(claimedId);
                            if (reserved && reserved.digest !== loadedDigest) {
                                throw new SecurityLimitError(
                                    `Remote schema '${uri}' conflicts with the ${reserved.source} schema reserved as '${claimedId}'.`,
                                    {code: "REMOTE_SCHEMA_ID_CONTENT_COLLISION", status: 502}
                                );
                            }
                            this.authoritativeSchemaIds.set(claimedId, {digest: loadedDigest, source: "remote"});
                        }

                        this._insertAsyncToSchemasAndDefs(loadedSchema);

                        // Prefer storing into the context that matches the schema's $schema if available
                        const targetCtx = this.ajvContexts[this._draftType(loadedSchema)];

                        if (targetCtx && targetCtx.referencedSchemaCache) {
                            targetCtx.referencedSchemaCache.set(uri, loadedSchema);
                            targetCtx.referencedSchemaMetadata.set(uri, {
                                bytes: observedBytes,
                                authoritativeIds: [...new Set(claimedIds)],
                                ajvAliases: [...new Set(ajvAliases)],
                                digest: loadedDigest
                            });
                            logger.debug(`Saved referenced schema to cache (context: ${targetCtx.type}): ${uri}`);
                        }

                        return cloneJson(loadedSchema);
                    }).catch(err => {
                        if (err instanceof SecurityLimitError) {
                            const reference = err.reference || uri;
                            if (!err.reference) {
                                err.reference = reference;
                            }
                            if (!/remote \$ref/i.test(err.message)) {
                                err.message = `Unable to resolve remote $ref '${reference}': ${err.message}`;
                            }
                            throw err;
                        }
                        const status = err.response ? err.response.status : "network/DNS/file";
                        logger.error(
                            `Failed to fetch referenced schema URI: ${uri} (Status: ${status}). Error: ${err.message || err}`
                        );
                        throw new SecurityLimitError(
                            `Unable to resolve remote $ref '${uri}' via network/DNS/file (status: ${status}).`,
                            {
                                code: "REMOTE_REFERENCE_RESOLUTION_FAILED",
                                status: 502,
                                reference: uri,
                                help: "Amend this $ref or make the referenced schema available to the Biovalidator deployment."
                            }
                        );
                    });
        };

        const createCompiler = (registerLocal = false) => {
            let ajvInstance = new AjvClass({
                allErrors: true,
                strict: false,
                strictSchema: this.securityConfig.schemaStrict,
                ...(type === "07" ? {ignoreKeywordsWithRef: true} : {}),
                loadSchema: loadSchema,
                $data: false,
                addUsedSchema: false,
                ownProperties: true
            });
            if (type === "07" || type === "2019") ajvInstance.addMetaSchema(draft06MetaSchema);
            if (type === "2019") ajvInstance.addMetaSchema(draft07MetaSchema);
            for (const keyword of this.securityConfig.annotationKeywords) {
                if (!ajvInstance.getKeyword(keyword)) ajvInstance.addKeyword(keyword);
            }

            addFormats(ajvInstance);
            require("ajv-errors")(ajvInstance);

            // add custom keywords to this AJV instance
            this.customKeywordValidators.forEach(customKeywordValidator => {
                ajvInstance = customKeywordValidator.configure(ajvInstance);
            });

            for (const local of registerLocal ? localSchemas.filter(candidate => candidate.type === type) : []) {
                try {
                    ajvInstance.addSchema(cloneJson(local.schema), local.schema.$id);
                } catch (error) {
                    throw new Error(`Failed to register local reference schema '${local.file}': ${error.message}`);
                }
            }
            return ajvInstance;
        };
        const ajvInstance = createCompiler(true);
        const registeredSchemas = new Map(localSchemas.filter(candidate => candidate.type === type)
            .map(local => [local.schema.$id, local.schema]));
        referencedSchemaCache.on("expired", (schemaId) => {
            const metadata = referencedSchemaMetadata.get(schemaId);
            referencedSchemaMetadata.delete(schemaId);
            this._releaseRemoteSchemaMetadata(metadata);
            try {
                ajvInstance.removeSchema(schemaId);
                for (const alias of metadata && metadata.ajvAliases || []) {
                    ajvInstance.removeSchema(alias);
                }
            } catch (error) {
                logger.warn(`Failed to evict expired remote schema '${schemaId}' from AJV context ${type}: ${error.message || error}`);
            }
        });
        validatorCache.on("del", (cacheKey) => validatorMetadata.delete(cacheKey));


        return {
            ajv: ajvInstance,
            createCompiler,
            loadSchema,
            registeredSchemas,
            referencedSchemaCache,
            referencedSchemaCacheMetrics,
            referencedSchemaMetadata,
            validatorCache,
            validatorCacheMetrics,
            validatorMetadata,
            type
        };
    }

    /**
     * Select the appropriate AJV context for a schema by inspecting its
     * $schema property. Defaults to the '2019' context for older drafts.
     */
    _draftType(schema) {
        const uri = schema && schema.$schema;
        if (typeof uri === "string" && /draft-0[67]\/schema#?$/.test(uri)) return "07";
        return typeof uri === "string" && uri.includes("2020") ? "2020" : "2019";
    }

    _getAjvContextForSchema(inputSchema) {
        // Determine which AJV context to use based on the $schema property when available
        const schemaUri = inputSchema && inputSchema.$schema;
        if (typeof schemaUri === 'string') {
            return this.ajvContexts[this._draftType(inputSchema)];
        }
        if (inputSchema && typeof inputSchema.$ref === 'string') {
            const registeredContext = Object.values(this.ajvContexts)
                .find((context) => context.registeredSchemas.has(inputSchema.$ref));
            if (registeredContext) {
                return registeredContext;
            }
        }
        // default to 2019 context (handles older drafts as well)
        return this.ajvContexts['2019'];
    }

    // Schema loading is context-specific now and implemented per AJV context (see _createAjvContext).

    _addCustomKeywordValidators(ajvInstance) {
        this.customKeywordValidators.forEach(customKeywordValidator => {
            ajvInstance = customKeywordValidator.configure(ajvInstance);
        });
        logger.info("Custom keywords successfully added. Number of custom keywords: " + this.customKeywordValidators.length);
        return ajvInstance;
    }


}

module.exports = BioValidator;
