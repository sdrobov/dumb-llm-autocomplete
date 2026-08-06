import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/unit/**/*.test.ts'],
        globals: false,
        environment: 'node',
        // setupFiles removed (each test file inlines its own vscode mock)
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            include: ['src/**/*.ts'],
            // extension.ts is counted; activate/deactivate are exercised via
            // extension.test.ts with the vscode module mocked.
            thresholds: {
                lines: 80,
                functions: 80,
                branches: 75,
                statements: 80,
            },
        },
    },
});
