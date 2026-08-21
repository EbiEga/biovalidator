const {loadSecurityConfig} = require("./src/utils/security-config");

module.exports = {
    testEnvironment: "node",
    moduleNameMapper: {
        "/axios/": "axios/dist/node/axios.cjs"
    },
    testMatch: ["<rootDir>/test/external/**/*.test.js"],
    // Keep Jest alive beyond the configured Axios deadline so failures report
    // the provider/HTTP result instead of Jest aborting the test first.
    testTimeout: loadSecurityConfig().outboundTimeoutMs + 10_000
};
