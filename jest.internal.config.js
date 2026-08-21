module.exports = {
    testEnvironment: "node",
    moduleNameMapper: {
        "/axios/": "axios/dist/node/axios.cjs"
    },
    testMatch: ["<rootDir>/test/**/*.test.js"],
    testPathIgnorePatterns: ["<rootDir>/test/external/"]
};
