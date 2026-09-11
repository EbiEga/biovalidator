const winston = require("winston");
const fs = require("fs");
require("winston-daily-rotate-file");
const {parsePositiveInteger} = require("./security-config");
const logger = winston.createLogger({
    level: process.env.BIOVALIDATOR_LOG_LEVEL || "info",
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
    exitOnError: false
});

function addLogDirectory(logDirectory) {
    if (process.env.BIOVALIDATOR_FILE_LOG_ENABLED === "false") return;
    fs.mkdirSync(logDirectory, {recursive: true, mode: 0o700});
    const transport = new winston.transports.DailyRotateFile({
        filename: "biovalidator-%DATE%.log",
        dirname: logDirectory,
        datePattern: "YYYY-MM-DD",
        maxSize: parsePositiveInteger(process.env, "BIOVALIDATOR_LOG_MAX_BYTES", 20 * 1024 * 1024),
        maxFiles: parsePositiveInteger(process.env, "BIOVALIDATOR_LOG_MAX_FILES", 14),
        options: {flags: "a", mode: 0o600},
        zippedArchive: true
    });
    transport.on("error", error => process.stderr.write(`File logging failed: ${error.message}\n`));
    logger.add(transport);
    return transport;
}
module.exports = {logger, addLogDirectory};
