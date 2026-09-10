const {logger} = require("../utils/winston");
const {log_error, log_info } = require("../utils/logger");
const BioValidator = require("./biovalidator-core");
const {readJsonFile} = require("../utils/file_utils");

class BioValidatorCli {
    constructor(pathToSchema, pathToJson, pathToRefSchema) {
        this.pathToSchema = pathToSchema
        this.pathToJson = pathToJson
        this.biovalidator = new BioValidator(pathToRefSchema);
    }

    async validate() {
        try {
            this.schema = readJsonFile(this.pathToSchema);
            this.data = readJsonFile(this.pathToJson);
            const output = await this.biovalidator.validate(this.schema, this.data);
            this.process_output(output);
            return output.length === 0 ? 0 : 1;
        } catch (error) {
            log_error(error.message || String(error));
            return 2;
        }
    }

    process_output(output) {
        if (output.length === 0) {
            log_info("Validation passed successfully.");
        } else {
            log_error("Validation failed with following error(s):\n")
            log_error(this.error_report(output));
        }
    }

    error_report(jsonErrors) {
        let errorOutput = "";
        jsonErrors.forEach( (errorObject) => {
            const dataPath = errorObject.dataPath;
            const errors = errorObject.errors;
            let errorStr = "";
            errors.forEach( (error) => {
                errorStr = errorStr.concat("\n\t", error);
            })
            errorOutput = errorOutput.concat(dataPath + errorStr + "\n");
        })

        return errorOutput;
    }
}

module.exports = BioValidatorCli;
