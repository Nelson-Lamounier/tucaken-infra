import { esmConfig } from '../../jest.config.base.mjs';

// Integration tests live under __tests__/integration/ and run via vitest
// (yarn test:integration). Jest picks up everything matching its default
// testRegex by default, which mistakenly catches setup.ts plus the vitest
// auth-flow suite — both fail to load under jest's runtime. Excluding the
// directory keeps the unit-test command (`yarn test`) clean.
export default {
  ...esmConfig,
  testPathIgnorePatterns: [
    ...(esmConfig.testPathIgnorePatterns ?? []),
    '/__tests__/integration/',
  ],
};
