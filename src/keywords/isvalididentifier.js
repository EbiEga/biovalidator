const ajv = require("ajv").default;
const axios = require('axios');
const CustomAjvError = require("../model/custom-ajv-error");
const {logger} = require("../utils/winston");
const constants = require("../utils/constants");
const SecurityLimitError = require("../model/security-limit-error");
const {loadSecurityConfig} = require("../utils/security-config");
const {SecureHttpClient} = require("../utils/secure-http-client");

class IsValidIdentifier {
    constructor(options = {}) {
        this.keywordName = "isValidIdentifier";
        this.identifiersOrgUrl = constants.IDENTIFIER_ORG_RESOLVER_URL;
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.sharedCacheEnabled = options.securityProfile !== "server";
        this.httpClient = options.httpClient || new SecureHttpClient({
            config: this.securityConfig,
            securityProfile: options.securityProfile || "compatible",
            adapter: options.adapter || axios
        });
    }

    configure(ajv) {
        return ajv.addKeyword({
            keyword: this.keywordName,
            type: "string",
            async: true,
            validate: this.validationFunction(),
            errors: true,
            schemaType: "object",
            metaSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    prefix: {type: "string", minLength: 1},
                    prefixes: {type: "array", minItems: 1, items: {type: "string", minLength: 1}}
                },
                oneOf: [
                    {required: ["prefix"]},
                    {required: ["prefixes"]}
                ]
            }
        });
    }

    validationFunction() {
        const { identifiersCache } = require('./shared-cache');

        const generateErrorObject = (message) => {
            return new CustomAjvError(this.keywordName, message, {});
        };

        return (schema, identifier) => {
            return new Promise((resolve, reject) => {
                const observedBytes = Buffer.byteLength(identifier);
                if (observedBytes > this.securityConfig.customKeywordStringMaxBytes) {
                    reject(new SecurityLimitError(
                        `An identifiers.org query exceeded this Biovalidator deployment's ${this.securityConfig.customKeywordStringMaxBytes}-byte limit.`,
                        {
                            code: "CUSTOM_KEYWORD_STRING_LIMIT",
                            configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES",
                            limit: {name: "custom_keyword_string_max_bytes", configured: this.securityConfig.customKeywordStringMaxBytes, observed: observedBytes, unit: "bytes"}
                        }
                    ));
                    return;
                }
                const prefixes = new Set(schema.prefixes || []);
                if (prefixes.size > this.securityConfig.customKeywordArrayMax) {
                    reject(new SecurityLimitError(
                        `isValidIdentifier.prefixes exceeded this Biovalidator deployment's ${this.securityConfig.customKeywordArrayMax}-entry limit.`,
                        {
                            code: "CUSTOM_KEYWORD_ARRAY_LIMIT",
                            configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_ARRAY_MAX",
                            limit: {name: "custom_keyword_array_max", configured: this.securityConfig.customKeywordArrayMax, observed: prefixes.size, unit: "entries"}
                        }
                    ));
                    return;
                }
                const oversizedPrefix = [schema.prefix, ...prefixes].find((value) =>
                    typeof value === "string" && Buffer.byteLength(value) > this.securityConfig.customKeywordStringMaxBytes);
                if (oversizedPrefix !== undefined) {
                    reject(new SecurityLimitError(
                        `An isValidIdentifier prefix exceeded this Biovalidator deployment's ` +
                        `${this.securityConfig.customKeywordStringMaxBytes}-byte limit.`,
                        {code: "CUSTOM_KEYWORD_STRING_LIMIT", configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES"}
                    ));
                    return;
                }
                const prefix = schema.prefix;
                const identifierPrefix = identifier.substring(0, identifier.indexOf(":"));
                let errors = [];
                let fatalError = null;

                if (prefix) {
                    identifier = prefix + ":" + identifier;
                } else if (prefixes && !prefixes.has(identifierPrefix)) {
                    errors.push(generateErrorObject(`"${identifierPrefix}" is not a valid namespace for the identifier. Allowed namespaces are [${new Array(...prefixes).join(', ')}]`));
                    reject(new ajv.ValidationError(errors));
                    return;
                }

                const cacheHit = this.sharedCacheEnabled && identifiersCache.has(identifier);
                let responsePromise;
                if (cacheHit) {
                    responsePromise = Promise.resolve(identifiersCache.get(identifier));
                    logger.debug("Returning cached response for identifiers.org request: " + identifier)
                } else {
                    const separatorIndex = identifier.indexOf(":");
                    const identifierPath = separatorIndex === -1
                        ? encodeURIComponent(identifier)
                        : `${encodeURIComponent(identifier.slice(0, separatorIndex))}:` +
                            encodeURIComponent(identifier.slice(separatorIndex + 1));
                    responsePromise = this.httpClient.getJson(this.identifiersOrgUrl + identifierPath, {
                        kind: "identifiers",
                        maxBytes: this.securityConfig.apiResponseMaxBytes,
                        cache: true
                    });
                }

                responsePromise.then((response) => {
                    if (this.sharedCacheEnabled && !cacheHit && response.status === 200) {
                        // Cache successful upstream responses, including negative resolutions.
                        identifiersCache.set(identifier, response);
                    }
                    if (response.status === 200 && response.data.payload.resolvedResources.length > 0) {
                        const resolvedUrl = response.data.payload.resolvedResources[0].compactIdentifierResolvedUrl;
                        logger.debug(`Returning resolved term: ${identifier} -> ${resolvedUrl}`);
                    } else {
                        errors.push(generateErrorObject(`Failed to resolve term from identifiers.org. [${response.errors}]`));
                    }
                }).catch(function (error) {
                    if (error instanceof SecurityLimitError || error && error.name === "SecurityLimitError") {
                        fatalError = error;
                    } else if (error.response && error.response.status === 400) {
                        errors.push(generateErrorObject(`Failed to resolve term from identifiers.org. [${error.response.data.errorMessage}]`));
                    } else {
                        errors.push(generateErrorObject(`Failed to resolve term from identifiers.org. [${error}]`));
                    }
                }).finally(function () {
                    if (fatalError) {
                        reject(fatalError);
                    } else if (errors.length > 0) {
                        reject(new ajv.ValidationError(errors));
                    } else {
                        resolve(true);
                    }
                });
            });
        };
    }
}

module.exports = IsValidIdentifier;
