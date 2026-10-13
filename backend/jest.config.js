/** Two projects: `unit` (pure rule-engine tests, no infrastructure) and `e2e` (needs Postgres + Redis from docker compose). */
const base = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }] },
  testEnvironment: 'node',
};

module.exports = {
  testTimeout: 60000,
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/test/**/*.spec.ts'] },
    {
      ...base,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      setupFiles: ['<rootDir>/test/load-env.ts'],
      globalSetup: '<rootDir>/test/global-setup.ts',
    },
  ],
};
