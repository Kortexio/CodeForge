/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    collectCoverage: true,
    coverageDirectory: '../../coverage/unit',
    coverageReporters: ['text', 'lcov', 'html'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: {
                target: 'ES2022',
                module: 'commonjs',
                moduleResolution: 'node',
                esModuleInterop: true,
                strict: true,
                skipLibCheck: true,
                resolveJsonModule: true,
            },
        }],
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@ai/(.*)$': '<rootDir>/../../src/ai/$1',
        '^@code-intelligence/(.*)$': '<rootDir>/../../src/code-intelligence/$1',
        '^@git-intelligence/(.*)$': '<rootDir>/../../src/git-intelligence/$1',
        '^@browser/(.*)$': '<rootDir>/../../src/browser/$1',
    },
};
