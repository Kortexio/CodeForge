/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>'],
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    collectCoverage: true,
    coverageDirectory: '../../coverage/integration',
    coverageReporters: ['text', 'lcov', 'html'],
    testTimeout: 30000,
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: '../../tsconfig.json',
        }],
    },
    moduleNameMapper: {
        '^@ai/(.*)$': '<rootDir>/../../src/ai/$1',
        '^@code-intelligence/(.*)$': '<rootDir>/../../src/code-intelligence/$1',
        '^@git-intelligence/(.*)$': '<rootDir>/../../src/git-intelligence/$1',
        '^@browser/(.*)$': '<rootDir>/../../src/browser/$1',
    },
};
