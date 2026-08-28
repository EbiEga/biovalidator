#!/usr/bin/env node
const {log_error} = require("./utils/logger");
const BioValidatorCli = require("./core/cli");
const BioValidatorServer = require("./core/server");

async function main() {
    const [{default: yargs}, {hideBin}] = await Promise.all([
        import("yargs/yargs"),
        import("yargs/helpers")
    ]);

    const argv = yargs(hideBin(process.argv))
        .usage(_getUsage())
        .alias('s', 'schema')
        .alias('d', 'data')
        .alias('r', 'ref')
        .alias('p', 'port')
        .array('remoteRef')
        .describe('schema', 'path to the schema file.')
        .describe('data', 'path to the data file.')
        .describe('ref', 'path, directory, or glob of local $ref schemas; each schema must have a unique $id.')
        .describe('remoteRef', 'allowlisted remote schema URL to fetch and warm before accepting server traffic; repeatable.')
        .describe('port', 'exposed port in server mode. Only valid in server mode.')
        .describe('baseUrl', 'base URL for the server. Only valid in server mode.')
        .describe('pidPath', 'PID file name and path. Only valid in server mode.')
        .describe('logDir', 'path to the log directory.')
        .example('node ./src/biovalidator.js --data=test_data.json --schema=test_schema.json',
            'Runs in CLI mode to validate \'test_data.json\' with \'test_schema.json\'')
        .parse();

    let help = argv["help"]
    let schemaRef = argv["ref"]
    let schema = argv["schema"]
    let data = argv["data"]
    let port = argv["port"]
    let baseUrl = argv["baseUrl"]
    let pidPath = argv["pidPath"]
    let logDir = argv["logDir"]
    let remoteRefs = argv["remoteRef"]

    if (help) {
        _printHelp();
    } else if (data || schema) {
        if (!_validateCliArgs(schema, data)) {
            process.exit(1);
        }
        new BioValidatorCli(schema, data, schemaRef).validate();
    } else {
        new BioValidatorServer(port, schemaRef)
            .withRemoteRefs(remoteRefs)
            .withBaseUrl(baseUrl)
            .withPid(pidPath)
            .withLogDir(logDir)
            .start();
    }
}

main().catch((error) => {
    log_error(error.message || String(error));
    process.exitCode = 1;
});

function _getUsage() {
    let helpText = "\nELIXIR biovalidator: JSON Schema validator with ontology extension\n";
    helpText = helpText.concat("usage: node ./src/biovalidator.js [--schema=path/to/schema.json] " +
        "[--data=path/to/data.json] [--ref=path/to/ref/dir]")
    return helpText
}

function _printHelp() {
    console.log(_getUsage())
}

function _validateCliArgs(schema, data) {
    let valid = true
    if (!schema || schema === "" || typeof schema === "boolean") {
        log_error("missing --schema. Please add schema file path to run in CLI mode.");
        valid = false;
    }
    if (!data || data === "" || typeof data === "boolean") {
        log_error("missing --data. Please add data file path to run in CLI mode.");
        valid = false;
    }

    return valid;
}
