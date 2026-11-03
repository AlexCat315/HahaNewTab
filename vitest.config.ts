import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig({
    ...viteConfig,
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./vitest.setup.ts'],
        alias: {
            '@': '/src'
        },
        exclude: ['node_modules', 'dist', 'tests/**'],
        passWithNoTests: true
    }
});
