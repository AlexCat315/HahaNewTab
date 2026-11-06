/**
 * 跨设备真链路验证（原生 storage.sync，Chrome 回调 / Firefox Promise 两种形态）
 *
 * 其余浏览器同步用例都跑在 localStorage 降级后端上，等于「同一台机器自己读自己写」，
 * 证明不了两件真会被用户遇到的事：
 *   1. 扩展环境里那层原生适配（Chrome 回调风格 / Firefox Promise 风格）对不对；
 *   2. 凭据从设备 A 传到设备 B 之后，B 在**开机那一刻**（走 cloudSync.store.init，
 *      不是手动调还原函数）能不能把登录状态拿回来。
 *
 * 同步总线当作浏览器账号同步区：A 的写入落到总线，然后清空本机存储（等价于换设备），
 * B 只能靠总线里那份东西还原。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCloudSyncStore } from '@/stores/cloudSync.store';
import { useCrossDeviceAuthStore } from '@/stores/crossDeviceAuth.store';
import {
    enableCrossDevice,
    hasRemoteCrossDeviceAuth,
    pushCrossDeviceAuth
} from '@/services/crossDeviceSync.service';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { STORAGE_KEYS } from '@/types/storage';

const TOKEN = 'ghp_deviceA_token';
const OLD_PASS = 'old-sync-pass';
const NEW_PASS = 'new-sync-pass';
const REMOTE_AUTH_KEY = 'haha_cross_device_auth';

/** 同步总线：模拟「浏览器账号里那一份」，A 写、B 读 */
const bus = vi.hoisted(() => ({ items: new Map<string, unknown>() }));

type ApiStyle = 'chrome' | 'firefox';

/** 按指定 API 形态把同步区接到总线上 */
function installNativeSyncArea(style: ApiStyle): void {
    bus.items.clear();
    const pick = (keys: string | string[]): string[] => (Array.isArray(keys) ? keys : [keys]);

    if (style === 'chrome') {
        // Chrome：回调风格，错误挂在 runtime.lastError 上
        (window as unknown as { chrome?: unknown }).chrome = {
            storage: {
                sync: {
                    get: (keys: string | string[], cb: (items: Record<string, unknown>) => void) => {
                        const result: Record<string, unknown> = {};
                        for (const key of pick(keys)) {
                            if (bus.items.has(key)) result[key] = bus.items.get(key);
                        }
                        cb(result);
                    },
                    set: (items: Record<string, unknown>, cb: () => void) => {
                        for (const [key, value] of Object.entries(items)) bus.items.set(key, value);
                        cb();
                    },
                    remove: (keys: string | string[], cb: () => void) => {
                        for (const key of pick(keys)) bus.items.delete(key);
                        cb();
                    }
                },
                onChanged: { addListener: () => {}, removeListener: () => {} }
            },
            runtime: {}
        };
        return;
    }

    // Firefox：browser.* 直接返回 Promise，没有 lastError
    (window as unknown as { browser?: unknown }).browser = {
        storage: {
            sync: {
                get: async (keys: string | string[]) => {
                    const result: Record<string, unknown> = {};
                    for (const key of pick(keys)) {
                        if (bus.items.has(key)) result[key] = bus.items.get(key);
                    }
                    return result;
                },
                set: async (items: Record<string, unknown>) => {
                    for (const [key, value] of Object.entries(items)) bus.items.set(key, value);
                },
                remove: async (keys: string | string[]) => {
                    for (const key of pick(keys)) bus.items.delete(key);
                }
            },
            onChanged: { addListener: () => {}, removeListener: () => {} }
        }
    };
}

function uninstallNativeSyncArea(): void {
    delete (window as unknown as { chrome?: unknown }).chrome;
    delete (window as unknown as { browser?: unknown }).browser;
}

/** GitHub / Gitee 一律按「有效 Token + 空 Gist」回应，只验凭据流转，不碰真实账号 */
function stubCloudApi(): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes('/user')
            ? { login: 'tester', id: 1, avatar_url: 'https://avatar.url' }
            : url.includes('/gists?')
                ? []
                : { id: 'gist_1', files: {} };
        return {
            status: 200,
            ok: true,
            json: async () => body,
            text: async () => JSON.stringify(body)
        } as Response;
    }) as unknown as typeof fetch;
}

/**
 * 按「哪些 Token 还活着」应答的 GitHub
 *
 * 撤销一个 Token 要让它的每个请求都 401，而不只是 /user：真实世界里 Gist 读写
 * 同样会被拒，而这正是本机凭据失效、需要跟上另一台设备那份的信号来源。
 */
function stubGitHubByLiveTokens(live: () => Iterable<string>): void {
    const SYNC_FILE = 'haha-newtab-sync.json';
    const emptyBundle = JSON.stringify({
        version: '1.1',
        lastModified: 0,
        device: 'Browser',
        data: {}
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? '';
        const url = String(input);
        const authorized = [...live()].some(token => auth.includes(token));

        const reply = (status: number, body: unknown): Response => ({
            status,
            statusText: status === 200 ? 'OK' : 'Unauthorized',
            ok: status >= 200 && status < 300,
            json: async () => body,
            text: async () => JSON.stringify(body)
        }) as Response;

        if (!authorized) {
            return reply(401, { message: 'Bad credentials' });
        }
        if (url.endsWith('/user')) {
            return reply(200, { login: 'tester', id: 1, avatar_url: 'https://avatar.url' });
        }
        if (url.includes('/gists?')) {
            return reply(200, [{ id: 'gist_1', files: { [SYNC_FILE]: {} } }]);
        }
        return reply(200, {
            id: 'gist_1',
            files: { [SYNC_FILE]: { content: emptyBundle } }
        });
    }) as unknown as typeof fetch;
}

function silentUI() {
    const store = useCloudSyncStore();
    store.setUIAdapter({
        showToast: () => {},
        showConfirm: async () => true,
        showPrompt: async () => null
    });
    return store;
}

/** 换一台全新设备：本机存储清空，只留下浏览器账号里那份同步区数据 */
async function becomeFreshDevice(): Promise<void> {
    localStorage.clear();
    await storageManager.setMany({
        [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
        [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
    });
    setActivePinia(createPinia());
}

/** 总线上当前的凭据记录 */
function remoteRecord(): Record<string, unknown> | null {
    const raw = bus.items.get(REMOTE_AUTH_KEY);
    return raw ? (raw as Record<string, unknown>) : null;
}

describe.each([['chrome'], ['firefox']] as const)('原生同步区（%s 风格 API）', (style) => {
    beforeEach(() => {
        localStorage.clear();
        setActivePinia(createPinia());
        browserApi.resetDetection();
        installNativeSyncArea(style);
        stubCloudApi();
    });

    afterEach(() => {
        uninstallNativeSyncArea();
        vi.restoreAllMocks();
        bus.items.clear();
    });

    it('设备 B 开机不会凭空登录（口令不在本机），输入口令后立刻还原', async () => {
        const storeA = silentUI();
        await storeA.login(TOKEN, 'github');
        await storeA.enableCrossDeviceSync(OLD_PASS);
        expect(remoteRecord()?.alg).toBe('AES-GCM');

        await becomeFreshDevice();
        const storeB = silentUI();
        await storeB.init();
        expect(storeB.token).toBeNull();

        expect(await storeB.restoreFromCrossDevice(OLD_PASS)).toBe(true);
        expect(storeB.token).toBe(TOKEN);
    });

    it('设备 B 用同一口令「开启浏览器同步」时同一次操作里就还原', async () => {
        const storeA = silentUI();
        await storeA.login(TOKEN, 'github');
        await storeA.enableCrossDeviceSync(OLD_PASS);

        await becomeFreshDevice();
        const storeB = silentUI();
        await storeB.init();
        const outcome = await storeB.enableCrossDeviceSync(OLD_PASS);

        expect(outcome.restored).toBe(true);
        expect(storeB.token).toBe(TOKEN);
    });

    it('设备 A 在未登录的状态下换了口令：旧密文原样留着，登录一次就换成新口令解得开的凭据', async () => {
        const storeA = silentUI();
        await storeA.login(TOKEN, 'github');
        await storeA.enableCrossDeviceSync(OLD_PASS);

        // 本机数据被清过一半：口令和 Token 都没了，同步区里仍是旧口令那份密文。
        // 「开启浏览器同步」这一步没有凭据可推，只记下新口令——旧密文必须留着，
        // 另一台设备说不定还拿它恢复得回来。
        await storageManager.setMany({
            [STORAGE_KEYS.CROSS_DEVICE_PASSPHRASE]: null,
            [STORAGE_KEYS.CLOUD_TOKEN]: null
        });
        const outcome = await storeA.enableCrossDeviceSync(NEW_PASS);
        expect(outcome.pushed).toBe(false);
        expect(remoteRecord()?.alg).toBe('AES-GCM');

        // 设备 A 登录一次：推送跟着本机口令走，同步区换成新口令加密的凭据
        await storeA.login(TOKEN, 'github');

        // 只有新口令的设备从此能拿到凭据（旧口令那份已经解不开了）
        await becomeFreshDevice();
        const storeB = silentUI();
        await storeB.init();
        expect(await storeB.restoreFromCrossDevice(NEW_PASS)).toBe(true);
        expect(storeB.token).toBe(TOKEN);
    });

    it('本机 Token 被平台拒了：不用重启，直接跟上同步区里另一台设备换的新 Token', async () => {
        const DEAD = 'ghp_revoked_token';
        const LIVE = 'ghp_rotated_token';
        const liveTokens = new Set([DEAD, LIVE]);
        stubGitHubByLiveTokens(() => liveTokens);

        // 另一台设备推来的还是旧 Token；本机凭口令采纳它，成为已登录、已开启的设备
        await enableCrossDevice(OLD_PASS, { token: DEAD, provider: 'github' });
        const store = silentUI();
        await store.init();
        expect(await store.restoreFromCrossDevice(OLD_PASS)).toBe(true);
        expect(store.token).toBe(DEAD);

        // 另一台设备换了 Token 并推上来，旧的那个在平台上被撤销了
        await pushCrossDeviceAuth({ token: LIVE, provider: 'github' });
        liveTokens.delete(DEAD);

        // 这一轮同步撞 401：本机凭据被清掉，紧接着采纳同步区里那份能用的
        const result = await store.sync({ silent: true });
        expect(result.authRejected).toBe(true);
        expect(store.token).toBe(LIVE);
        expect(await hasRemoteCrossDeviceAuth()).toBe(true);
    });

    it('设备 A 登出后同步区清空，重新登录再推一次仍是可用凭据', async () => {
        const storeA = silentUI();
        await storeA.login(TOKEN, 'github');
        await storeA.enableCrossDeviceSync(OLD_PASS);
        await storeA.logout();
        expect(remoteRecord()).toBeNull();

        const again = silentUI();
        await again.login(TOKEN, 'github');
        expect(remoteRecord()?.alg).toBe('AES-GCM');

        await becomeFreshDevice();
        const storeB = silentUI();
        await storeB.init();
        expect(await storeB.restoreFromCrossDevice(OLD_PASS)).toBe(true);
        expect(storeB.token).toBe(TOKEN);
    });

    it('设备 B 采纳后成为正式成员：改 Token 会把自己那份推回去', async () => {
        const storeA = silentUI();
        await storeA.login(TOKEN, 'github');
        await storeA.enableCrossDeviceSync(OLD_PASS);

        await becomeFreshDevice();
        const storeB = silentUI();
        await storeB.init();
        await storeB.restoreFromCrossDevice(OLD_PASS);
        const crossB = useCrossDeviceAuthStore();
        expect(crossB.enabled).toBe(true);

        const ROTATED = 'ghp_deviceB_rotated';
        await storeB.login(ROTATED, 'github');
        expect(JSON.stringify(remoteRecord())).not.toContain(TOKEN);

        // 第三台设备拿到的应该是 B 的新 Token
        await becomeFreshDevice();
        const storeC = silentUI();
        await storeC.init();
        expect(await storeC.restoreFromCrossDevice(OLD_PASS)).toBe(true);
        expect(storeC.token).toBe(ROTATED);
    });

    it('口令错时给出可读原因，不静默失败', async () => {
        const storeA = silentUI();
        await storeA.login(TOKEN, 'github');
        await storeA.enableCrossDeviceSync(OLD_PASS);

        await becomeFreshDevice();
        const storeB = silentUI();
        await storeB.init();
        await expect(storeB.restoreFromCrossDevice('totally-wrong-pass')).rejects.toThrow('同步密码不正确');
        expect(storeB.token).toBeNull();
    });
});
