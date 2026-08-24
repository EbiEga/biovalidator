const axios = require("axios");
const constants = require("./constants");
const {loadSecurityConfig} = require("./security-config");
const {SecureHttpClient} = require("./secure-http-client");
const SecurityLimitError = require("../model/security-limit-error");

const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 20000;
const OMITTED_SERVER_FILTERS = new Set(["groupField", "queryFields"]);

class OlsSearchError extends Error {
    constructor(term, reason) {
        super(`OLS search failed for [${term}]: ${reason}`);
        this.name = "OlsSearchError";
    }
}

class OlsResolutionError extends Error {
    constructor(code, term, iris = []) {
        const message = code === "ambiguous"
            ? `OLS term is ambiguous: [${term}] resolved to multiple IRIs.`
            : `Could not retrieve IRI for [${term}]`;
        super(message);
        this.name = "OlsResolutionError";
        this.code = code;
        this.term = term;
        this.iris = iris;
    }
}

class OlsSearchClient {
    constructor(searchUrl, options = {}) {
        this.searchUrl = searchUrl || constants.OLS_SEARCH_URL;
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.httpClient = options.httpClient || new SecureHttpClient({
            config: this.securityConfig,
            adapter: options.adapter || axios
        });
    }

    async search(term, filters = {}) {
        const baseUrl = this._buildUrl(term, filters);
        const cacheEntries = [];
        try {
            const docs = [];
            let expectedTotal = null;
            let start = 0;

            do {
                const pageUrl = new URL(baseUrl.toString());
                pageUrl.searchParams.set("start", String(start));

                const page = await this._fetchPage(term, pageUrl, start, cacheEntries);
                if (expectedTotal === null) {
                    expectedTotal = page.numFound;
                } else if (page.numFound !== expectedTotal) {
                    throw new OlsSearchError(term, "result count changed during pagination");
                }

                if (page.docs.length === 0 && docs.length < expectedTotal) {
                    throw new OlsSearchError(
                        term,
                        `incomplete paginated response: received ${docs.length} of ${expectedTotal} records`
                    );
                }

                docs.push(...page.docs);
                start += page.docs.length;

                if (docs.length > expectedTotal) {
                    throw new OlsSearchError(term, "malformed response returned more records than numFound");
                }
            } while (docs.length < expectedTotal);

            const result = {docs, numFound: expectedTotal};
            if (typeof this.httpClient.commitCache === "function") {
                this.httpClient.commitCache(cacheEntries);
            }
            return result;
        } catch (error) {
            if (typeof this.httpClient.discardCache === "function") {
                this.httpClient.discardCache(cacheEntries);
            }
            throw error;
        }
    }

    async findExactMatches(term, fields, filters = {}) {
        const result = await this.search(term, filters);
        const matches = result.docs.filter((doc) =>
            fields.some((field) => doc[field] === term)
        );

        for (const doc of matches) {
            if (typeof doc.iri !== "string" || doc.iri.length === 0) {
                throw new OlsSearchError(term, "exact match is missing a valid IRI");
            }
        }

        return matches;
    }

    async resolveUniqueIri(term, fields, filters = {}) {
        const matches = await this.findExactMatches(term, fields, filters);
        const iris = [...new Set(matches.map((doc) => doc.iri))];

        if (iris.length === 0) {
            throw new OlsResolutionError("not_found", term);
        }
        if (iris.length > 1) {
            throw new OlsResolutionError("ambiguous", term, iris);
        }

        return iris[0];
    }

    _buildUrl(term, filters) {
        let url;
        try {
            url = new URL(this.searchUrl);
        } catch (error) {
            throw new OlsSearchError(term, `invalid search endpoint: ${this.searchUrl}`);
        }

        url.searchParams.delete("q");
        url.searchParams.delete("start");
        url.searchParams.delete("rows");
        url.searchParams.delete("groupField");
        url.searchParams.delete("queryFields");
        url.searchParams.set("q", term);
        url.searchParams.set("exact", "true");
        url.searchParams.set("rows", String(PAGE_SIZE));

        for (const [key, value] of Object.entries(filters)) {
            if (!OMITTED_SERVER_FILTERS.has(key) &&
                value !== undefined && value !== null && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }

        return url;
    }

    async _fetchPage(term, url, requestedStart, cacheSink) {
        let response;
        try {
            response = await this.httpClient.getJson(url.toString(), {
                kind: "ols",
                maxBytes: this.securityConfig.apiResponseMaxBytes,
                cache: true,
                cacheSink
            });
        } catch (error) {
            if (error instanceof SecurityLimitError || error && error.name === "SecurityLimitError") {
                throw error;
            }
            const status = error.response && error.response.status;
            const responseMessage = error.response && error.response.data &&
                (error.response.data.errorMessage || error.response.data.message);
            const reason = status
                ? `HTTP ${status}${responseMessage ? `: ${responseMessage}` : ""}`
                : (error.message || String(error));
            throw new OlsSearchError(term, reason);
        }

        if (!response || response.status !== 200) {
            const status = response && response.status !== undefined
                ? response.status
                : "unknown";
            throw new OlsSearchError(term, `HTTP ${status}`);
        }

        const payload = response.data && response.data.response;
        if (!payload || !Array.isArray(payload.docs) ||
            !Number.isInteger(payload.numFound) || payload.numFound < 0 ||
            !Number.isInteger(payload.start) || payload.start < 0) {
            throw new OlsSearchError(term, "malformed response payload");
        }
        if (payload.start !== requestedStart) {
            throw new OlsSearchError(
                term,
                `incomplete paginated response: requested start ${requestedStart}, received ${payload.start}`
            );
        }
        if (payload.docs.some((doc) => !doc || typeof doc !== "object" || Array.isArray(doc))) {
            throw new OlsSearchError(term, "malformed response document");
        }

        return {
            docs: payload.docs,
            numFound: payload.numFound
        };
    }
}

module.exports = {
    OlsSearchClient,
    OlsSearchError,
    OlsResolutionError,
    PAGE_SIZE,
    REQUEST_TIMEOUT_MS
};
