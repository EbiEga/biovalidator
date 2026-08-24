const Ajv = require("ajv").default;
const axios = require("axios");
const {logger} = require("../utils/winston");
const CustomAjvError = require("../model/custom-ajv-error");
const {default: ajv} = require("ajv");
const SecurityLimitError = require("../model/security-limit-error");
const {loadSecurityConfig} = require("../utils/security-config");
const {SecureHttpClient} = require("../utils/secure-http-client");

const taxonomySearchUrl = "https://www.ebi.ac.uk/ena/taxonomy/rest/any-name";
const NoResults = "No results.";

class IsValidTaxonomy {
    constructor(keywordName, options = {}) {
        this.keywordName = keywordName ? keywordName : "isValidTaxonomy";
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.httpClient = options.httpClient || new SecureHttpClient({
            config: this.securityConfig,
            adapter: options.adapter || axios
        });
    }

    configure(ajv) {
        const keywordDefinition = {
            keyword: this.keywordName,
            async: this.isAsync(),
            type: "string",
            validate: this.generateKeywordFunction(),
            errors: true,
            schemaType: ["boolean", "string"],
            metaSchema: {anyOf: [{type: "boolean"}, {enum: ["true", "false"]}]}
        };

        return ajv.addKeyword(keywordDefinition);
    }

    keywordFunction() {
        return this.generateKeywordFunction();
    }

    isAsync() {
        return true;
    }

    generateKeywordFunction() {
        return (schema, data) => {
            return new Promise((resolve, reject) => {
                if (schema) {
                    let errors = [];
                    let fatalError = null;

                    const taxonomyExpression = data;
                    const observedBytes = Buffer.byteLength(taxonomyExpression);
                    if (observedBytes > this.securityConfig.customKeywordStringMaxBytes) {
                        reject(new SecurityLimitError(
                            `An ENA taxonomy query exceeded this Biovalidator deployment's ${this.securityConfig.customKeywordStringMaxBytes}-byte limit.`,
                            {
                                code: "CUSTOM_KEYWORD_STRING_LIMIT",
                                configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES",
                                limit: {name: "custom_keyword_string_max_bytes", configured: this.securityConfig.customKeywordStringMaxBytes, observed: observedBytes, unit: "bytes"}
                            }
                        ));
                        return;
                    }
                    const encodedTaxonomyUri = encodeURIComponent(taxonomyExpression);
                    const url = [taxonomySearchUrl, encodedTaxonomyUri].join("/");
                    const cacheEntries = [];
                    let cacheableResponse = false;

                    logger.log("debug", `Looking for taxonomy [${taxonomyExpression}] with ENA taxonomy validator.`);

                    const taxonomyPromise = this.httpClient.getJson(url, {
                        kind: "ena",
                        maxBytes: this.securityConfig.apiResponseMaxBytes,
                        cache: true,
                        cacheSink: cacheEntries
                    });

                    taxonomyPromise
                        .then((response) => {
                            const validRows = response.status === 200 && Array.isArray(response.data) &&
                                response.data.every((row) => row && typeof row === "object" && !Array.isArray(row) &&
                                    (typeof row.taxId === "string" || typeof row.taxId === "number") &&
                                    typeof row.submittable === "string");
                            if (validRows) {
                                cacheableResponse = true;
                                let numFound = response.data.length;

                                if (numFound === 1 && response.data[0]["taxId"] && response.data[0]["submittable"] === "true") {
                                    logger.debug(`Returning resolved term from ENA taxonomy: [${taxonomyExpression}]`);
                                } else if (numFound === 0) {
                                    generateNotExistsErrorMessage()
                                } else {
                                    errors.push(new CustomAjvError(
                                        "isValidTaxonomy", `Failed to resolve taxonomy. Something went wrong while validating the given taxonomy expression [${taxonomyExpression}], try again.`,
                                        {keyword: "isValidTaxonomy"})
                                    );
                                }
                            } else {
                                generateNotExistsErrorMessage();
                            }

                            function generateNotExistsErrorMessage() {
                                logger.warn(`Failed to resolve taxonomy. Term not present: [${taxonomyExpression}]`);
                                errors.push(new CustomAjvError(
                                    "isValidTaxonomy", `provided taxonomy expression does not exist: [${taxonomyExpression}]`, {keyword: "isValidTaxonomy"})
                                );
                            }

                        })
                        .catch((error) => {
                            if (error instanceof SecurityLimitError || error && error.name === "SecurityLimitError") {
                                fatalError = error;
                                return;
                            }
                            logger.error(`Failed to resolve taxonomy. [${error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : error}]`);
                            errors.push(new CustomAjvError(
                                "isValidTaxonomy", "Something went wrong while validating term, try again." + (error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : ''),
                                {keyword: "isValidTaxonomy"})
                            );
                        })
                        .finally(() => {
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
                } else {
                    resolve(true);
                }
            });

        };    }
}

module.exports = IsValidTaxonomy;
