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
        this.httpClient = options.httpClient || new SecureHttpClient({
            config: this.securityConfig,
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

                const separatorIndex = identifier.indexOf(":");
                const identifierPath = separatorIndex === -1
                    ? encodeURIComponent(identifier)
                    : `${encodeURIComponent(identifier.slice(0, separatorIndex))}:` +
                        encodeURIComponent(identifier.slice(separatorIndex + 1));
                const cacheEntries = [];
                let cacheableResponse = false;
                const responsePromise = this.httpClient.getJson(this.identifiersOrgUrl + identifierPath, {
                    kind: "identifiers",
                    maxBytes: this.securityConfig.apiResponseMaxBytes,
                    cache: true,
                    cacheSink: cacheEntries
                });

                responsePromise.then((response) => {
                    const payload = response && response.status === 200 && response.data && response.data.payload;
                    const validResources = payload && Array.isArray(payload.resolvedResources) &&
                        payload.resolvedResources.every((resource) => resource && typeof resource === "object" &&
                            !Array.isArray(resource) && typeof resource.compactIdentifierResolvedUrl === "string" &&
                            resource.compactIdentifierResolvedUrl.length > 0);
                    if (validResources) {
                        cacheableResponse = true;
                    }
                    if (cacheableResponse && payload.resolvedResources.length > 0) {
                        const resolvedUrl = payload.resolvedResources[0].compactIdentifierResolvedUrl;
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
                }).finally(() => {
                    if (cacheableResponse && typeof this.httpClient.commitCache === "function") {
                        this.httpClient.commitCache(cacheEntries);
                    } else if (!cacheableResponse && typeof this.httpClient.discardCache === "function") {
                        this.httpClient.discardCache(cacheEntries);
                    }
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
