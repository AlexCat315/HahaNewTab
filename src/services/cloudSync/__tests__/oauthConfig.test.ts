/**
 * OAuth Client ID 单测：内置值由项目维护，构建注入可覆盖
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BUILT_IN_CLIENT_ID, githubClientId } from '../oauthConfig';

describe('GitHub OAuth Client ID', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('默认使用项目内置值', () => {
        expect(githubClientId()).toBe(BUILT_IN_CLIENT_ID.trim());
    });

    it('构建注入覆盖内置值并去掉首尾空白', () => {
        vi.stubEnv('VITE_GITHUB_CLIENT_ID', '  client-id-from-build  ');
        expect(githubClientId()).toBe('client-id-from-build');
    });

    it('注入空串时仍退回内置值', () => {
        vi.stubEnv('VITE_GITHUB_CLIENT_ID', '   ');
        expect(githubClientId()).toBe(BUILT_IN_CLIENT_ID.trim());
    });
});
