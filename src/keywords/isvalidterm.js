const {logger} = require("../utils/winston");
const CustomAjvError = require("../model/custom-ajv-error");
const {default: ajv} = require("ajv");
const {
    OlsSearchClient,
    OlsResolutionError
} = require("../utils/ols_search_client");
const SecurityLimitError = require("../model/security-limit-error");
const {loadSecurityConfig} = require("../utils/security-config");

class IsValidTerm {
    constructor(keywordName, olsSearchUrl, options = {}) {
        const constants = require('../utils/constants');
        this.keywordName = keywordName ? keywordName : "isValidTerm";
        this.olsSearchUrl = olsSearchUrl || constants.OLS_SEARCH_URL;
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.olsClient = new OlsSearchClient(this.olsSearchUrl, options);
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
        return async (schema, data) => {
            if (schema === false || schema === "false") {
                logger.warn(`Trying to work with empty schema. Why are we here : [${schema}]`);
                return true;
            }
            const observedBytes = Buffer.byteLength(data);
            if (observedBytes > this.securityConfig.customKeywordStringMaxBytes) {
                throw new SecurityLimitError(
                    `An OLS term exceeded this Biovalidator deployment's ${this.securityConfig.customKeywordStringMaxBytes}-byte query limit.`,
                    {
                        code: "CUSTOM_KEYWORD_STRING_LIMIT",
                        configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES",
                        limit: {name: "custom_keyword_string_max_bytes", configured: this.securityConfig.customKeywordStringMaxBytes, observed: observedBytes, unit: "bytes"}
                    }
                );
            }

            try {
                await this.olsClient.resolveUniqueIri(data, ["iri"]);
                logger.debug(`Returning resolved term from OLS: [${data}]`);
                return true;
            } catch (error) {
                if (!(error instanceof OlsResolutionError)) {
                    logger.error(`OLS service failure while validating term [${data}]: ${error.message || error}`);
                    throw error;
                }

                const message = error.code === "ambiguous"
                    ? error.message
                    : `provided term does not exist in OLS: [${data}]`;
                logger.warn(`Failed to resolve term from OLS: ${message}`);
                throw new ajv.ValidationError([
                    new CustomAjvError(
                        "isValidTerm",
                        message,
                        {keyword: "isValidTerm"}
                    )
                ]);
            }
        };
    }
}

module.exports = IsValidTerm;
