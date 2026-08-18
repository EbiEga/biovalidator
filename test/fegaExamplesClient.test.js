jest.mock("axios");

const axios = require("axios");
const {FegaExamplesClient} = require("../src/utils/fega_examples_client");

const treeResponse = (paths) => ({
    data: {
        tree: paths.map((entry) => (
            typeof entry === "string"
                ? {path: entry, type: "blob"}
                : entry
        ))
    }
});

const exampleWrapper = (entity) => ({
    schema: {
        "$ref": `https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/${entity}/schema.json`
    },
    data: {
        "@type": `ega:${entity}`,
        id: `ega:${entity}`
    }
});

describe("FegaExamplesClient", () => {
    beforeEach(() => {
        axios.mockReset();
    });

    test("filters minimal valid entity examples and parses wrappers", async () => {
        axios.mockImplementation((config) => {
            if (config.url.includes("/git/trees/")) {
                return Promise.resolve(treeResponse([
                    "schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json",
                    "schemas/entities/cohort/examples/valid/cohort-valid-detailed-study-defined.json",
                    "schemas/entities/cohort/examples/invalid/cohort-invalid-required-name.json",
                    "schemas/entities/cohort/schema.json",
                    "schemas/common/examples/valid/common-valid-minimal.json",
                    {path: "schemas/entities/datafile/examples/valid/datafile-valid-minimal-fastq.json", type: "tree"}
                ]));
            }
            return Promise.resolve({data: exampleWrapper("cohort")});
        });

        const client = new FegaExamplesClient();
        const payload = await client.getExamples();

        expect(payload).toMatchObject({
            source: "EGA-archive/fega-metadata-schema",
            ref: "main",
            pattern: "schemas/entities/*/examples/valid/*minimal*.json"
        });
        expect(payload.examples).toHaveLength(1);
        expect(payload.examples[0]).toMatchObject({
            id: "cohort-valid-minimal-study-defined",
            entity: "cohort",
            name: "cohort-valid-minimal-study-defined.json",
            path: "schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json",
            schema: exampleWrapper("cohort").schema,
            data: exampleWrapper("cohort").data
        });
        expect(payload.examples[0].rawUrl).toBe(
            "https://raw.githubusercontent.com/EGA-archive/fega-metadata-schema/main/schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json"
        );
        expect(axios).toHaveBeenCalledTimes(2);
    });

    test("sorts examples by entity and name for stable UI order", async () => {
        axios.mockImplementation((config) => {
            if (config.url.includes("/git/trees/")) {
                return Promise.resolve(treeResponse([
                    "schemas/entities/protocol/examples/valid/protocol-valid-minimal-computational-workflow.json",
                    "schemas/entities/biomaterial/examples/valid/biomaterial-valid-minimal-organism.json",
                    "schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json"
                ]));
            }
            const entity = config.url.includes("/protocol/") ? "protocol" :
                config.url.includes("/biomaterial/") ? "biomaterial" : "cohort";
            return Promise.resolve({data: exampleWrapper(entity)});
        });

        const client = new FegaExamplesClient();
        const payload = await client.getExamples();

        expect(payload.examples.map((example) => example.entity)).toEqual([
            "biomaterial",
            "cohort",
            "protocol"
        ]);
    });

    test("retains the last successful payload when a refresh fails", async () => {
        axios.mockImplementation((config) => {
            if (config.url.includes("/git/trees/")) {
                return Promise.resolve(treeResponse([
                    "schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json"
                ]));
            }
            return Promise.resolve({data: exampleWrapper("cohort")});
        });

        const client = new FegaExamplesClient();
        const previous = await client.getExamples();
        axios.mockRejectedValue(new Error("GitHub unavailable"));

        await expect(client.refreshExamples()).rejects.toThrow("GitHub unavailable");
        await expect(client.getExamples()).resolves.toEqual(previous);
        expect(axios).toHaveBeenCalledTimes(3);
    });

    test("rejects malformed wrappers missing schema or data", async () => {
        axios.mockImplementation((config) => {
            if (config.url.includes("/git/trees/")) {
                return Promise.resolve(treeResponse([
                    "schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json"
                ]));
            }
            return Promise.resolve({data: {schema: {}}});
        });

        const client = new FegaExamplesClient();

        await expect(client.getExamples()).rejects.toThrow(
            "Malformed FEGA example wrapper: schemas/entities/cohort/examples/valid/cohort-valid-minimal-study-defined.json"
        );
    });

    test("rejects malformed tree responses", async () => {
        axios.mockResolvedValue({data: {}});
        const client = new FegaExamplesClient();

        await expect(client.getExamples()).rejects.toThrow(
            "Malformed FEGA metadata schema tree response"
        );
    });
});
