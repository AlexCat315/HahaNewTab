/**
 * 启动那一轮的凭据判定
 *
 * 「浏览器同步/token 同步不上」最常见的现场不是传输入写失败，而是本机留着一份
 * 平台已经不再认的 Token：界面按缓存的用户信息一路显示「已连接」，
 * 每一次同步却注定失败，而且没人补一句为什么。
 *
 * 这里只喂两个结果：平台明确拒绝（401）与连不上（网络），
 * 前者必须把凭据请出去并说清楚，后者绝不能当成 Token 失效。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCloudSyncStore } from '../cloudSync.store';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { STORAGE_KEYS } from '@/types/storage';
import type { GitHubUserInfo } from '@/types/cloudSync.types';

const TEST_TOKEN = 'ghp_testtoken';
const TEST_GIST_ID = 'gist_123';
const TEST_USER: GitHubUserInfo = { login: 'testuser', id: 1, avatar: 'https://avatar.url' };

function createResponse(body: unknown, status = 200): Response {
    return {
        status,
        statusText: status === 200 ? 'OK' : 'Unauthorized',
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body))
    } as Response;
}

/** 每一次请求都返回同一个响应 */
function mockFetchAll(response: Response) {
    globalThis.fetch = vi.fn().mockResolvedValue(response);
}

function mockFetchReject(error: Error) {
    globalThis.fetch = vi.fn().mockRejectedValue(error);
}

async function seedLoggedInDevice() {
    await storageManager.setMany({
        [STORAGE_KEYS.CLOUD_TOKEN]: TEST_TOKEN,
        [STORAGE_KEYS.CLOUD_GIST_ID]: TEST_GIST_ID,
        [STORAGE_KEYS.CLOUD_AUTO_SYNC]: true,
        [STORAGE_KEYS.CLOUD_USER_INFO]: TEST_USER
    });
}

describe('启动时的凭据判定', () => {
    let toasts: Array<{ message: string; type?: string }>;

    beforeEach(async () => {
        setActivePinia(createPinia());
        localStorage.clear();
        browserApi.resetDetection();
        await storageManager.setMany({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        });
        toasts = [];
        const store = useCloudSyncStore();
        store.setUIAdapter({
            showToast: (message, type = 'info') => toasts.push({ message, type }),
            showConfirm: async () => true,

        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('平台拒绝已保存的 Token（401）：清掉凭据并说明原因，不停在「已连接」', async () => {
        await seedLoggedInDevice();
        mockFetchAll(createResponse({ message: 'Bad credentials' }, 401));

        const store = useCloudSyncStore();
        await store.init();

        expect(store.token).toBeNull();
        expect(store.isLoggedIn).toBe(false);
        expect(await storageManager.get(STORAGE_KEYS.CLOUD_TOKEN)).toBeNull();
        expect(toasts.some(t => t.type === 'error' && /Token|授权/.test(t.message))).toBe(true);
    });

    it('只是连不上（网络失败）：不能当成 Token 失效，且仍要走启动那一轮同步', async () => {
        await seedLoggedInDevice();
        mockFetchReject(new TypeError('Failed to fetch'));

        const store = useCloudSyncStore();
        await store.init();

        expect(store.token).toBe(TEST_TOKEN);
        // 启动那一轮真的尝试过：失败原因要说出来，不能因为「校验没过」就悄悄跳过
        expect(toasts.some(t => t.type === 'error' && /无法连接/.test(t.message))).toBe(true);
    });

    it('Token 有效：保持已连接，启动那一轮同步照常进行', async () => {
        await seedLoggedInDevice();
        const responses = [
            createResponse({ login: 'testuser', id: 1, avatar_url: 'https://avatar.url' }),
            createResponse({ id: TEST_GIST_ID, files: { 'haha-newtab-sync.json': { content: '{"version":"1.1","lastModified":0,"device":"Browser","data":{}}' } } })
        ];
        let index = 0;
        globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(responses[index++] ?? createResponse({}, 404)));

        const store = useCloudSyncStore();
        await store.init();

        expect(store.token).toBe(TEST_TOKEN);
        expect(store.isLoggedIn).toBe(true);
    });
});
