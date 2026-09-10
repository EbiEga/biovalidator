const CurieExpansion = require("../utils/curie_expansion");
const ajv = require("ajv").default;
const CustomAjvError = require("../model/custom-ajv-error");
const {logger} = require("../utils/winston");
const {
    OlsSearchClient,
    OlsResolutionError
} = require("../utils/ols_search_client");
const SecurityLimitError = require("../model/security-limit-error");
const {loadSecurityConfig} = require("../utils/security-config");

const SUPPORTED_QUERY_FIELDS = new Set(["obo_id", "label"]);

class GraphRestriction {
    constructor(keywordName, olsSearchUrl, options = {}) {
        const constants = require('../utils/constants');
        this.keywordName = keywordName ? keywordName : "graphRestriction";
        this.olsSearchUrl = olsSearchUrl || constants.OLS_SEARCH_URL;
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.httpOptions = options;
        this.olsClient = new OlsSearchClient(this.olsSearchUrl, options);
    }

    /**
     *
     * Given an AJV validator, returns the validator with the graph-restriction keyword applied
     *
     * @param ajv
     */
    configure(ajv) {
        const keywordDefinition = {
            keyword: this.keywordName,
            async: GraphRestriction._isAsync(),
            type: "string",
            validate: this.generateKeywordFunction(),
            errors: true,
            schemaType: "object",
            metaSchema: {
                type: "object",
                additionalProperties: false,
                required: ["ontologies"],
                oneOf: [{required: ["childrenOf"]}, {required: ["allChildrenOf"]}],
                properties: {
                    childrenOf: {type: "array", minItems: 1, items: {type: "string", minLength: 1}},
                    ontologies: {type: "array", minItems: 1, items: {type: "string", minLength: 1}},
                    allChildrenOf: {type: "array", minItems: 1, items: {type: "string", minLength: 1}},
                    includeSelf: {type: "boolean"},
                    queryFields: {type: "array", minItems: 1, items: {enum: ["obo_id", "label"]}},
                    $comment: {type: "string"}
                }
            }
        };

        return ajv.addKeyword(keywordDefinition);
    }

    keywordFunction() {
        return this.generateKeywordFunction();
    }

    isAsync() {
        return GraphRestriction._isAsync();
    }

    static _isAsync() {
        return true;
    }

    generateKeywordFunction() {
        const curieExpansion = new CurieExpansion(this.olsSearchUrl, this.httpOptions);

        const callCurieExpansion = (terms) => {
            let expanded = terms.map((t) => {
                if (CurieExpansion.isCurie(t)) {
                    return curieExpansion.expandCurie(t);
                } else {
                    return t
                }
            });

            return Promise.all(expanded);
        };

        const generateErrorObject = (message) => {
            return new CustomAjvError("graphRestriction", message, {});
        };

        return async (schema, data) => {
            for (const option of ["relations", "direct", "classes"]) {
                if (Object.prototype.hasOwnProperty.call(schema, option)) {
                    throw new SecurityLimitError(`graphRestriction.${option} is not supported by the OLS search API. Use childrenOf or allChildrenOf containing the parent terms; OLS search chooses its hierarchy relations.`, {
                        code: "GRAPH_RESTRICTION_OPTION_UNSUPPORTED", status: 422,
                        help: "Use exactly one of childrenOf or allChildrenOf with a non-empty parent-term array. Remove classes, direct, and relations."
                    });
                }
            }
            const hierarchyFields = ["childrenOf", "allChildrenOf"].filter(field =>
                Object.prototype.hasOwnProperty.call(schema, field));
            if (hierarchyFields.length !== 1) {
                throw new SecurityLimitError("graphRestriction requires exactly one of childrenOf or allChildrenOf.", {
                    code: "GRAPH_RESTRICTION_OPTION_UNSUPPORTED", status: 422
                });
            }
            const hierarchyField = hierarchyFields[0];
            const parentTerms = schema[hierarchyField];
            const ontologyIds = schema.ontologies;
            const queryFields = schema.queryFields || ["obo_id"];

            for (const [name, values] of [
                [hierarchyField, parentTerms],
                ["ontologies", ontologyIds],
                ["queryFields", queryFields]
            ]) {
                if (Array.isArray(values) && values.length > this.securityConfig.customKeywordArrayMax) {
                    throw new SecurityLimitError(
                        `graphRestriction.${name} exceeded this Biovalidator deployment's ${this.securityConfig.customKeywordArrayMax}-entry limit.`,
                        {
                            code: "CUSTOM_KEYWORD_ARRAY_LIMIT",
                            configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_ARRAY_MAX",
                            limit: {name: "custom_keyword_array_max", configured: this.securityConfig.customKeywordArrayMax, observed: values.length, unit: "entries"}
                        }
                    );
                }
                const oversized = Array.isArray(values)
                    ? values.find((value) => typeof value === "string" &&
                        Buffer.byteLength(value) > this.securityConfig.customKeywordStringMaxBytes)
                    : undefined;
                if (oversized !== undefined) {
                    throw new SecurityLimitError(
                        `A graphRestriction.${name} value exceeded this Biovalidator deployment's ` +
                        `${this.securityConfig.customKeywordStringMaxBytes}-byte limit.`,
                        {code: "CUSTOM_KEYWORD_STRING_LIMIT", configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES"}
                    );
                }
            }
            if (typeof data === "string" && Buffer.byteLength(data) > this.securityConfig.customKeywordStringMaxBytes) {
                throw new SecurityLimitError(
                    `A graphRestriction term exceeded this Biovalidator deployment's ${this.securityConfig.customKeywordStringMaxBytes}-byte limit.`,
                    {code: "CUSTOM_KEYWORD_STRING_LIMIT", configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES"}
                );
            }

            if (!Array.isArray(parentTerms) || parentTerms.length === 0 || !Array.isArray(ontologyIds) || ontologyIds.length === 0) {
                throw new ajv.ValidationError([
                    generateErrorObject(
                        "Missing required variable in schema graphRestriction, required properties are: childrenOf or allChildrenOf, and ontologies (non-empty arrays)."
                    )
                ]);
            }
            if (!Array.isArray(queryFields) || queryFields.length === 0 ||
                queryFields.some((field) => !SUPPORTED_QUERY_FIELDS.has(field))) {
                throw new ajv.ValidationError([
                    generateErrorObject(
                        "Invalid graphRestriction queryFields. Supported fields are: obo_id, label."
                    )
                ]);
            }

            if (schema.includeSelf === true && parentTerms.includes(data)) {
                return data;
            }

            let parentIris;
            try {
                parentIris = await callCurieExpansion(parentTerms);
            } catch (error) {
                if (error instanceof OlsResolutionError) {
                    throw new ajv.ValidationError([generateErrorObject(error.message)]);
                }
                logger.error(`OLS service failure while expanding graphRestriction parent terms: ${error.message || error}`);
                throw error;
            }

            const parentTerm = parentIris.join(",");
            const ontologyId = ontologyIds.join(",").replace(/obo:/g, "");
            for (const [name, value] of [[hierarchyField, parentTerm], ["ontologies", ontologyId]]) {
                if (Buffer.byteLength(value) > this.securityConfig.customKeywordStringMaxBytes) {
                    throw new SecurityLimitError(
                        `The combined graphRestriction.${name} query exceeded this Biovalidator deployment's ` +
                        `${this.securityConfig.customKeywordStringMaxBytes}-byte limit.`,
                        {code: "CUSTOM_KEYWORD_STRING_LIMIT", configuration: "BIOVALIDATOR_CUSTOM_KEYWORD_STRING_MAX_BYTES"}
                    );
                }
            }

            try {
                await this.olsClient.resolveUniqueIri(data, queryFields, {
                    [hierarchyField]: parentTerm,
                    ontology: ontologyId
                });
                logger.debug(`Returning resolved term from OLS: [${data}]`);
                return true;
            } catch (error) {
                if (!(error instanceof OlsResolutionError)) {
                    logger.error(`OLS service failure while evaluating graphRestriction for [${data}]: ${error.message || error}`);
                    throw error;
                }

                const message = error.code === "ambiguous"
                    ? error.message
                    : `Provided term is not child of [${parentTerm}]`;
                throw new ajv.ValidationError([generateErrorObject(message)]);
            }
        };

    }
}

module.exports = GraphRestriction;
