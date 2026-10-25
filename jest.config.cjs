module.exports = {
  testEnvironment: "node",

  modulePathIgnorePatterns: ["<rootDir>/.runtime/"],

  testMatch: ["<rootDir>/.test-build/tests/**/*.test.js"],

  setupFilesAfterEnv: ["<rootDir>/.test-build/tests/network-guard.js"],

  collectCoverageFrom: [
    ".test-build/src/**/*.js",
    "!.test-build/src/openapi.js",
    "!.test-build/src/types.js",
  ],

  coverageDirectory: "coverage",
  coverageReporters: ["text", "json-summary", "lcov"],

  testTimeout: 15000,

  transform: {},
  coverageProvider: "v8",
};
