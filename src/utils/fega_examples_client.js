const axios = require("axios");
const path = require("path");
const SecurityLimitError = require("../model/security-limit-error");
const {loadSecurityConfig} = require("./security-config");
const {SecureHttpClient} = require("./secure-http-client");

const DEFAULT_REPO = "EGA-archive/fega-metadata-schema";
const DEFAULT_REF = "main";
const DEFAULT_CACHE_TTL_SECONDS = 3600;
const EXAMPLE_PATTERN = "schemas/entities/*/examples/valid/*minimal*.json";
const EXAMPLE_PATH_REGEX = /^schemas\/(?:entities\/([^/]+)\/|graph\/)examples\/valid\/([^/]*minimal[^/]*\.json)$/;

class FegaExamplesClient {
    constructor(options = {}) {
        this.securityConfig = options.securityConfig || loadSecurityConfig();
        this.repo = options.repo || process.env.FEGA_METADATA_SCHEMA_REPO || DEFAULT_REPO;
        this.ref = options.ref || process.env.FEGA_METADATA_SCHEMA_REF || DEFAULT_REF;
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repo)) {
            throw new Error("Invalid FEGA metadata repository: expected owner/repository.");
        }
        if (typeof this.ref !== "string" || this.ref.length === 0 || this.ref.length > 255 || /[\u0000-\u001f]/.test(this.ref)) {
            throw new Error("Invalid FEGA metadata ref.");
        }
        this.httpClient = options.httpClient || new SecureHttpClient({
            config: this.securityConfig,
            securityProfile: "server",
            adapter: options.adapter || axios
        });
        this.cacheTtlSeconds = Number(
            options.cacheTtlSeconds ||
            process.env.FEGA_EXAMPLES_CACHE_TTL_SECONDS ||
            DEFAULT_CACHE_TTL_SECONDS
        );
        if (!Number.isFinite(this.cacheTtlSeconds) || this.cacheTtlSeconds < 0) {
            this.cacheTtlSeconds = DEFAULT_CACHE_TTL_SECONDS;
        }
        this.cache = null;
    }

    async getExamples() {
        const now = Date.now();
        if (this.cache && this.cache.expiresAt > now) {
            return this.cache.payload;
        }

        const payload = await this._fetchExamples();
        this._savePayload(payload);
        return payload;
    }

    /**
     * Fetch a fresh examples payload without discarding the last successful
     * payload until the replacement has been fetched successfully.
     */
    async refreshExamples() {
        const payload = await this._fetchExamples({cache: false});
        this._savePayload(payload);
        if (typeof this.httpClient.clearKind === "function") {
            this.httpClient.clearKind("githubApi");
            this.httpClient.clearKind("githubRaw");
        }
        return payload;
    }

    _savePayload(payload) {
        this.cache = {
            payload,
            expiresAt: Date.now() + (this.cacheTtlSeconds * 1000)
        };
    }

    clearCache() {
        this.cache = null;
        if (typeof this.httpClient.clearKind === "function") {
            this.httpClient.clearKind("githubApi");
            this.httpClient.clearKind("githubRaw");
        }
    }

    async _fetchExamples(options = {}) {
        const treeResult = await this._fetchGitTree(options);
        const tree = treeResult.tree;
        if (tree.length > this.securityConfig.githubTreeMaxEntries) {
            throw new SecurityLimitError(
                `The FEGA Git tree exceeded this Biovalidator deployment's ${this.securityConfig.githubTreeMaxEntries}-entry limit.`,
                {
                    code: "FEGA_TREE_ENTRY_LIMIT",
                    status: 502,
                    configuration: "BIOVALIDATOR_GITHUB_TREE_MAX_ENTRIES",
                    limit: {
                        name: "github_tree_max_entries",
                        configured: this.securityConfig.githubTreeMaxEntries,
                        observed: tree.length,
                        unit: "entries"
                    }
                }
            );
        }
        const exampleFiles = tree
            .filter((entry) => entry && entry.type === "blob" && EXAMPLE_PATH_REGEX.test(entry.path))
            .map((entry) => entry.path)
            .sort((left, right) => left.localeCompare(right));
        if (exampleFiles.length > this.securityConfig.fegaExampleMaxEntries) {
            throw new SecurityLimitError(
                `The FEGA repository returned ${exampleFiles.length} matching examples, above this ` +
                `Biovalidator deployment's ${this.securityConfig.fegaExampleMaxEntries}-example limit.`,
                {
                    code: "FEGA_EXAMPLE_ENTRY_LIMIT",
                    status: 502,
                    configuration: "BIOVALIDATOR_FEGA_EXAMPLE_MAX_ENTRIES",
                    limit: {
                        name: "fega_example_max_entries",
                        configured: this.securityConfig.fegaExampleMaxEntries,
                        observed: exampleFiles.length,
                        unit: "entries"
                    }
                }
            );
        }

        const examples = await mapWithConcurrency(
            exampleFiles,
            Math.min(16, this.securityConfig.outboundConcurrency),
            (filePath) => this._fetchExample(filePath, treeResult.sha || this.ref, options)
        );
        examples.sort((left, right) => (
            left.entity.localeCompare(right.entity) ||
            left.name.localeCompare(right.name)
        ));

        return {
            source: this.repo,
            ref: this.ref,
            revision: treeResult.sha || null,
            pattern: EXAMPLE_PATTERN,
            examples
        };
    }

    async _fetchGitTree(options = {}) {
        const url = `https://api.github.com/repos/${this.repo}/git/trees/${encodeURIComponent(this.ref)}?recursive=1`;
        const response = await this.httpClient.getJson(url, {
            kind: "githubApi",
            maxBytes: this.securityConfig.githubTreeMaxBytes,
            cache: options.cache !== false
        });
        if (!response || !response.data || !Array.isArray(response.data.tree)) {
            throw new Error("Malformed FEGA metadata schema tree response");
        }
        return {sha: typeof response.data.sha === "string" ? response.data.sha : null, tree: response.data.tree};
    }

    async _fetchExample(filePath, revision, options = {}) {
        const match = filePath.match(EXAMPLE_PATH_REGEX);
        if (!match) {
            throw new Error(`Invalid FEGA example path: ${filePath}`);
        }

        const entity = match[1] || "graph";
        const name = path.posix.basename(filePath);
        const id = name.replace(/\.json$/, "");
        const rawUrl = this._rawUrl(filePath, revision);
        const response = await this.httpClient.getJson(rawUrl, {
            kind: "githubRaw",
            maxBytes: this.securityConfig.remoteSchemaMaxBytes,
            cache: options.cache !== false
        });
        const wrapper = response && response.data;

        if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper) ||
            !Object.prototype.hasOwnProperty.call(wrapper, "schema") ||
            !Object.prototype.hasOwnProperty.call(wrapper, "data") ||
            !wrapper.schema || typeof wrapper.schema !== "object" || Array.isArray(wrapper.schema)) {
            throw new Error(`Malformed FEGA example wrapper: ${filePath}`);
        }

        return {
            id,
            entity,
            name,
            path: filePath,
            rawUrl,
            schema: wrapper.schema,
            data: wrapper.data
        };
    }

    _rawUrl(filePath, revision = this.ref) {
        return `https://raw.githubusercontent.com/${this.repo}/${encodeURIComponent(revision)}/${filePath}`;
    }
}

async function mapWithConcurrency(values, concurrency, mapper) {
    const results = new Array(values.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(values[index], index);
        }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, worker));
    return results;
}

module.exports = {
    FegaExamplesClient,
    EXAMPLE_PATH_REGEX,
    EXAMPLE_PATTERN,
    mapWithConcurrency
};
