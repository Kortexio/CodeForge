/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    collectCoverage: false,
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: {
                    target: 'ES2022',
                    module: 'commonjs',
                    moduleResolution: 'node',
                    esModuleInterop: true,
                    strict: true,
                    skipLibCheck: true,
                    resolveJsonModule: true,
                },
            },
        ],
    },
    moduleNameMapper: {
        '^vscode$': '<rootDir>/vscode-mock.js',
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
};
