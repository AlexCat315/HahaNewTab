/**
 * CloudSyncService 测试
 * 覆盖：设置加载、Token 验证、双向合并同步 sync()（下载-合并-应用-上传-base 更新）、
 * 全量上传 upload() 写 base、applyDownloadedData 过滤与 base 更新、
 * 按注册表校验拒绝结构非法的数据、写回本地期间的 isApplyingRemoteData 信号、
 * 拖动排序这类纯顺序变更的采纳与 base 更新、
 * 失败策略 Toast 分类（网络错误 / 超时 / 401 清 Token / 频率限制）、
 * 自动同步连续失败时提示收敛为一轮一次。
 * 自动同步的触发与防抖已移到 cloudSync store（监听存储内核），不在此文件覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudSyncService } from '@/services/cloudSync.service';
import { externalizeAssets } from '@/utils/syncAssets.util';
import { STORAGE_KEYS } from '@/types/storage';
import type { AppNavigatorData, AppItem } from '@/types/app';
import type { UserUiLib } from '@/types/ui';
import type {
    CloudSyncStorage,
    ICloudSyncDataManager,
    ICloudSyncUIAdapter
} from '@/types/cloudSync.types';
import type { StorageValue } from '@/types/storage';

const TEST_TOKEN = 'ghp_test';
const TEST_GIST_ID = 'gist_1';
const SYNC_FILE_NAME = 'haha-newtab-sync.json';

/** 存储内核的内存替身：云同步只按内核接口读写，这里逐一对齐 */
function createMockStorage(): CloudSyncStorage {
    const store = new Map<string, StorageValue>();
    return {
        get: vi.fn(async (key: string): Promise<StorageValue | null> => store.get(key) ?? null),
        getMany: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.map(key => [key, store.get(key) ?? null]))
        ),
        set: vi.fn(async (key: string, value: StorageValue) => {
            store.set(key, value);
        }),
        setMany: vi.fn(async (items: Record<string, StorageValue>) => {
            for (const [key, value] of Object.entries(items)) {
                store.set(key, value);
            }
        })
    };
}

function createMockDataManager(): ICloudSyncDataManager {
    return {
        syncNow: vi.fn(async () => undefined),
        applyStorageSnapshot: vi.fn(async () => true)
    };
}

function createMockUI(): ICloudSyncUIAdapter {
    return {
        showToast: vi.fn(),
        showConfirm: vi.fn(async () => true),
        showPrompt: vi.fn(async () => null)
    };
}

function createService() {
    const storage = createMockStorage();
    const dataManager = createMockDataManager();
    const ui = createMockUI();
    const service = new CloudSyncService({ storage, dataManager, ui });
    return { service, storage, dataManager, ui };
}

function createResponse(body: unknown, status = 200): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(text)
    } as Response;
}

/** 构造包含指定同步数据的 Gist 响应 */
function createGistResponse(remoteData: Record<string, unknown>): Response {
    const syncData = {
        version: '1.0',
        lastModified: Date.now(),
        device: 'Chrome',
        data: remoteData
    };
    return createResponse({
        id: TEST_GIST_ID,
        files: {
            [SYNC_FILE_NAME]: { content: JSON.stringify(syncData) }
        }
    });
}

/** mock fetch：GET 一律返回 Gist（内含 remoteData），PATCH 返回成功 */
function stubSyncFetch(remoteData: Record<string, unknown>) {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve(createGistResponse(remoteData))
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/** fetch 是否发起过 PATCH 上传（参数结构化，兼容任意 vi.fn 类型的 mock） */
function hasPatchCall(fetchMock: { mock: { calls: ReadonlyArray<readonly unknown[]> } }): boolean {
    return fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
}

/** 预置已登录状态（token + gistId）并加载到 service */
async function seedSignedIn(
    service: CloudSyncService,
    storage: CloudSyncStorage,
    extra: Record<string, StorageValue> = {}
): Promise<void> {
    await storage.set(STORAGE_KEYS.CLOUD_TOKEN, TEST_TOKEN);
    await storage.set(STORAGE_KEYS.CLOUD_GIST_ID, TEST_GIST_ID);
    for (const [key, value] of Object.entries(extra)) {
        await storage.set(key, value);
    }
    await service.loadSettings();
}

/** 默认给每个 id 一个独立 URL，避免触发 URL 去重（去重逻辑在 syncMerge 单测里覆盖） */
const app = (id: string, name: string): AppItem => ({
    id,
    name,
    url: `https://example.com/${id}`,
    category: 'c1'
});
const EMPTY_UI_LIB: UserUiLib = { categories: [], items: [] };

/** 构造三方合并场景所需的 base/local/remote 种子数据 */
function seedMergeFixture(localApps: AppItem[], baseApps: AppItem[]) {
    const localData: AppNavigatorData = { categories: [], apps: localApps };
    const baseData: AppNavigatorData = { categories: [], apps: baseApps };
    return {
        [STORAGE_KEYS.MAIN_DATA]: localData,
        [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB,
        [STORAGE_KEYS.CLOUD_SYNC_BASE]: {
            [STORAGE_KEYS.MAIN_DATA]: baseData,
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        }
    };
}

describe('CloudSyncService', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllTimers();
    });

    it('初始状态为未登录', () => {
        const { service } = createService();
        expect(service.isLoggedIn).toBe(false);
        expect(service.isSyncing).toBe(false);
        expect(service.settings.token).toBeNull();
        expect(service.settings.autoSync).toBe(false);
    });

    it('loadSettings 一次批量读取全部配置', async () => {
        const { service, storage } = createService();
        await storage.setMany({
            [STORAGE_KEYS.CLOUD_TOKEN]: 'ghp_test',
            [STORAGE_KEYS.CLOUD_AUTO_SYNC]: true
        });

        await service.loadSettings();

        expect(service.settings.token).toBe('ghp_test');
        expect(service.settings.autoSync).toBe(true);
        expect(storage.getMany).toHaveBeenCalledTimes(1);
    });

    it('saveToken 拒绝空字符串', async () => {
        const { service, ui } = createService();
        const result = await service.saveToken('   ');
        expect(result).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('请输入 Token', 'error');
    });

    it('validateToken 无 Token 返回 false', async () => {
        const { service } = createService();
        const result = await service.validateToken(null);
        expect(result).toBe(false);
    });

    it('validateToken 成功时解析用户信息并保存', async () => {
        const { service, storage } = createService();
        const mockFetch = vi.fn().mockResolvedValue({
            status: 200,
            ok: true,
            json: async () => ({ login: 'tester', id: 123, avatar_url: 'https://avatar.png' })
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await service.validateToken('ghp_valid');
        expect(result).toBe(true);
        expect(service.settings.userInfo).toEqual({
            login: 'tester',
            id: 123,
            avatar: 'https://avatar.png'
        });
        expect(storage.setMany).toHaveBeenCalledWith(
            expect.objectContaining({
                appNavigator_cloudSync_userInfo: {
                    login: 'tester',
                    id: 123,
                    avatar: 'https://avatar.png'
                },
                appNavigator_cloudSync_token: 'ghp_valid'
            })
        );
    });

    it('findOrCreateGist 在未登录时抛出错误', async () => {
        const { service } = createService();
        await expect(service.findOrCreateGist()).rejects.toThrow('未配置 Token');
    });

    it('upload 在未登录时返回错误', async () => {
        const { service, ui } = createService();
        const result = await service.upload();
        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('请先配置 Token', 'error');
    });

    it('download 在未登录时返回错误', async () => {
        const { service } = createService();
        const result = await service.download();
        expect(result.success).toBe(false);
        expect(result.message).toBe('请先配置 Token');
    });

    it('applyDownloadedData 只应用注册表登记的同步键并更新 base', async () => {
        const { service, dataManager, storage } = createService();
        const mainData = { categories: [], apps: [] };
        const uiLib = { categories: [], items: [] };
        const syncData = {
            version: '1.0',
            lastModified: 1700000000000,
            device: 'Chrome',
            data: {
                [STORAGE_KEYS.MAIN_DATA]: mainData,
                [STORAGE_KEYS.USER_UI_LIB]: uiLib,
                // 个性化设置现在也参与同步
                [STORAGE_KEYS.SELECTED_THEME]: 'material-rose',
                // 未登记的键与设备本地态一律忽略
                unknown_key: 'should_be_ignored',
                [STORAGE_KEYS.SIDEBAR_COLLAPSED]: true
            }
        };
        const result = await service.applyDownloadedData(syncData);
        expect(result).toBe(true);
        // 只保留注册表登记过的同步键
        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith({
            [STORAGE_KEYS.MAIN_DATA]: mainData,
            [STORAGE_KEYS.USER_UI_LIB]: uiLib,
            [STORAGE_KEYS.SELECTED_THEME]: 'material-rose'
        });
        // 成功后写入 base 快照与同步时间
        expect(storage.setMany).toHaveBeenCalledWith({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: {
                [STORAGE_KEYS.MAIN_DATA]: mainData,
                [STORAGE_KEYS.USER_UI_LIB]: uiLib,
                [STORAGE_KEYS.SELECTED_THEME]: 'material-rose'
            },
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: 1700000000000
        });
    });

    it('应用云端数据到本地期间给出 isApplyingRemoteData 信号（自动同步据此不回调）', async () => {
        const { service, dataManager } = createService();
        const mainData: AppNavigatorData = { categories: [], apps: [app('a1', 'A')] };
        let flagDuringApply = false;
        (dataManager.applyStorageSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            flagDuringApply = service.isApplyingRemoteData;
            return true;
        });

        await service.applyDownloadedData({
            version: '1.0',
            lastModified: 1700000000000,
            device: 'Chrome',
            data: { [STORAGE_KEYS.MAIN_DATA]: mainData, [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB }
        });

        expect(flagDuringApply).toBe(true);
        expect(service.isApplyingRemoteData).toBe(false);
    });

    it('sync 拒绝结构非法的云端数据：不合并、不应用、不上传', async () => {
        const { service, storage, dataManager, ui } = createService();
        await seedSignedIn(service, storage, seedMergeFixture([app('a1', 'A')], [app('a1', 'A')]));
        const fetchMock = stubSyncFetch({ [STORAGE_KEYS.MAIN_DATA]: { categories: 'broken' } });

        const result = await service.sync();

        expect(result.success).toBe(false);
        expect(result.message).toBe('云端应用数据格式无效');
        expect(dataManager.applyStorageSnapshot).not.toHaveBeenCalled();
        expect(hasPatchCall(fetchMock)).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('同步失败：云端应用数据格式无效', 'error');
    });

    it('setAutoSync 更新状态并写入存储', async () => {
        const { service, storage } = createService();
        await service.setAutoSync(true);
        expect(service.settings.autoSync).toBe(true);
        expect(storage.set).toHaveBeenCalledWith('appNavigator_cloudSync_autoSync', true);
    });

    // ==================== sync() 双向合并同步 ====================

    it('sync 在未登录时返回错误（silent 时不提示）', async () => {
        const { service, ui } = createService();
        const result = await service.sync({ silent: true });
        expect(result.success).toBe(false);
        expect(result.message).toBe('请先配置 Token');
        expect(ui.showToast).not.toHaveBeenCalled();
    });

    it('sync 三方合并：本地与远端各有更新时，应用合并结果并上传，更新 base', async () => {
        const { service, storage, dataManager, ui } = createService();
        // base: a1='A'；本地改 a1 并新增 a2；远端未改 a1、新增 a3
        await seedSignedIn(service, storage, seedMergeFixture(
            [app('a1', 'A-local'), app('a2', 'A2')],
            [app('a1', 'A')]
        ));
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A'), app('a3', 'A3')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        const fetchMock = stubSyncFetch(remoteData);

        const result = await service.sync();

        expect(result.success).toBe(true);
        expect(result.applied).toBe(true);
        expect(result.uploaded).toBe(true);

        // 合并结果：本地修改优先（a1='A-local'），本地新增 a2 保留，远端新增 a3 追加末尾
        const mergedData: AppNavigatorData = {
            categories: [],
            apps: [app('a1', 'A-local'), app('a2', 'A2'), app('a3', 'A3')]
        };
        const expectedMerged = {
            [STORAGE_KEYS.MAIN_DATA]: mergedData,
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith(expectedMerged);
        // 与远端不同 → PATCH 上传
        expect(hasPatchCall(fetchMock)).toBe(true);
        // 成功后写 base 快照与同步时间
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: expectedMerged,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: expect.any(Number)
        }));
        expect(ui.showToast).toHaveBeenCalledWith('同步完成：已拉取云端更新，已上传本地更新', 'success');
    });

    it('sync 本地、远端与 base 一致时，不应用也不上传', async () => {
        const { service, storage, dataManager, ui } = createService();
        const sameData = seedMergeFixture([app('a1', 'A')], [app('a1', 'A')]);
        await seedSignedIn(service, storage, sameData);
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        const fetchMock = stubSyncFetch(remoteData);

        const result = await service.sync();

        expect(result.success).toBe(true);
        expect(result.applied).toBe(false);
        expect(result.uploaded).toBe(false);
        expect(dataManager.applyStorageSnapshot).not.toHaveBeenCalled();
        expect(hasPatchCall(fetchMock)).toBe(false);
        // 即使无变更也会更新 base 与同步时间
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: remoteData,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: expect.any(Number)
        }));
        expect(ui.showToast).toHaveBeenCalledWith('同步完成：本地与云端已一致', 'success');
    });

    it('sync 仅远端有更新时应用到本地，不上传', async () => {
        const { service, storage, dataManager, ui } = createService();
        // 本地与 base 一致，远端修改了 a1
        await seedSignedIn(service, storage, seedMergeFixture([app('a1', 'A')], [app('a1', 'A')]));
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A-remote')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        const fetchMock = stubSyncFetch(remoteData);

        const result = await service.sync();

        expect(result.success).toBe(true);
        expect(result.applied).toBe(true);
        expect(result.uploaded).toBe(false);
        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith(remoteData);
        expect(hasPatchCall(fetchMock)).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('同步完成：已拉取云端更新', 'success');
    });

    it('sync 仅本地有更新时上传远端，不应用本地', async () => {
        const { service, storage, dataManager, ui } = createService();
        // 远端与 base 一致，本地修改了 a1
        await seedSignedIn(service, storage, seedMergeFixture([app('a1', 'A-local')], [app('a1', 'A')]));
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        const fetchMock = stubSyncFetch(remoteData);

        const result = await service.sync();

        expect(result.success).toBe(true);
        expect(result.applied).toBe(false);
        expect(result.uploaded).toBe(true);
        expect(dataManager.applyStorageSnapshot).not.toHaveBeenCalled();
        expect(hasPatchCall(fetchMock)).toBe(true);
        expect(ui.showToast).toHaveBeenCalledWith('同步完成：已上传本地更新', 'success');
    });

    it('sync 另一端拖动排序时本机采纳新顺序，也不把旧顺序推回云端', async () => {
        const { service, storage, dataManager } = createService();
        // 本地与 base 内容和顺序都一致，远端只调换了先后（每一项内容都没变）
        const sameOrder = [app('a1', 'A'), app('a2', 'B')];
        await seedSignedIn(service, storage, seedMergeFixture(sameOrder, sameOrder));
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a2', 'B'), app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        const fetchMock = stubSyncFetch(remoteData);

        const result = await service.sync();

        expect(result.applied).toBe(true);
        expect(result.uploaded).toBe(false);
        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith(remoteData);
        expect(hasPatchCall(fetchMock)).toBe(false);

        // base 同步刷成新顺序，否则下一轮同步会误判「本地改过」，把旧顺序推上云
        const newBase = (await storage.get(STORAGE_KEYS.CLOUD_SYNC_BASE)) as Record<string, AppNavigatorData>;
        expect(newBase[STORAGE_KEYS.MAIN_DATA].apps.map((item) => item.id)).toEqual(['a2', 'a1']);
    });

    it('sync base 为 null（首次同步）时本地与远端做并集合并', async () => {
        const { service, storage, dataManager } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('l1', '本地站点')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('r1', '远端站点')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        stubSyncFetch(remoteData);

        const result = await service.sync();

        expect(result.success).toBe(true);
        expect(result.applied).toBe(true);
        expect(result.uploaded).toBe(true);
        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('l1', '本地站点'), app('r1', '远端站点')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
    });

    it('sync 首次同步时同 id 冲突按「谁写得更晚」定夺：本地没编辑过则采用云端版本', async () => {
        const { service, storage, dataManager } = createService();
        // 出厂默认数据与云端同名站点共用 id '1'，不打 DATA_UPDATED_AT 的新设备不该覆盖云端
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('1', '出厂名')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
        stubSyncFetch({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('1', '云端改名'), app('r9', '云端独有')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });

        await service.sync();

        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('1', '云端改名'), app('r9', '云端独有')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
    });

    it('sync 首次同步时本地编辑更晚则同 id 冲突保留本地', async () => {
        const { service, storage, dataManager } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('1', '本地改名')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB,
            [STORAGE_KEYS.DATA_UPDATED_AT]: Date.now() + 60000
        });
        stubSyncFetch({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('1', '云端改名'), app('r9', '云端独有')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });

        await service.sync();

        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('1', '本地改名'), app('r9', '云端独有')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
    });

    it('sync 静默模式成功时不 Toast', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage, seedMergeFixture([app('a1', 'A')], [app('a1', 'A')]));
        stubSyncFetch({
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });

        const result = await service.sync({ silent: true });

        expect(result.success).toBe(true);
        expect(ui.showToast).not.toHaveBeenCalled();
    });

    it('sync 并发调用时第二次直接返回「同步进行中」', async () => {
        const { service, storage } = createService();
        await seedSignedIn(service, storage, seedMergeFixture([], []));
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        // 首个请求挂起，待断言后放行
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let first = true;
        vi.stubGlobal('fetch', vi.fn((_url: string, _init?: RequestInit) => {
            if (first) {
                first = false;
                return gate.then(() => createGistResponse(remoteData));
            }
            return Promise.resolve(createGistResponse(remoteData));
        }));

        const p1 = service.sync();
        const r2 = await service.sync();
        expect(r2.success).toBe(false);
        expect(r2.message).toBe('同步进行中');
        // 被挡下的这一轮本地改动没送出去，调用方（cloudSync store）据此重新排程
        expect(r2.retry).toBe(true);

        release();
        const r1 = await p1;
        expect(r1.success).toBe(true);
    });

    // ==================== sync() 失败策略 ====================

    it('sync 网络不可达（TypeError）时提示无法连接 GitHub，silent 也提示', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        const result = await service.sync({ silent: true });

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith(
            '同步失败：无法连接 GitHub，请检查网络或代理（国内可能需代理访问）',
            'error'
        );
    });

    it('自动同步连续失败只提示一次', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        const first = await service.sync({ silent: true });
        const second = await service.sync({ silent: true });
        const third = await service.sync({ silent: true });

        // 每一轮都要求调用方重新排程，但断网期间的提示不跟着重试一遍遍弹
        expect([first.retry, second.retry, third.retry]).toEqual([true, true, true]);
        expect(ui.showToast).toHaveBeenCalledTimes(1);
    });

    it('失败提示过后若有一轮同步成功，下一次故障重新提示', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage, seedMergeFixture([app('a1', 'A')], [app('a1', 'A')]));
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        const okFetch = stubSyncFetch(remoteData);
        let offline = true;
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (offline) {
                return Promise.reject(new TypeError('Failed to fetch'));
            }
            return okFetch(url, init);
        }));

        await service.sync({ silent: true });
        expect(ui.showToast).toHaveBeenCalledTimes(1);

        // 网络恢复：这一轮走通，故障标记复位
        offline = false;
        const recovered = await service.sync({ silent: true });
        expect(recovered.success).toBe(true);

        // 再次断网仍要提示
        offline = true;
        await service.sync({ silent: true });
        expect(ui.showToast).toHaveBeenCalledTimes(2);
    });

    it('sync 请求超时（AbortError）时提示超时', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')));

        const result = await service.sync({ silent: true });

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith(
            '同步失败：无法连接 GitHub（请求超时），请检查网络或代理（国内可能需代理访问）',
            'error'
        );
    });

    it('sync 收到 401（未缓存 gistId）时清空本地 Token 并提示重新连接', async () => {
        const { service, storage, ui } = createService();
        // 不预置 gistId：findOrCreateGist 直接走 listGists，401 经 throwForStatus 分类
        await storage.set(STORAGE_KEYS.CLOUD_TOKEN, TEST_TOKEN);
        await service.loadSettings();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Bad credentials' }, 401)));

        const result = await service.sync();

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('同步失败：Token 已失效，请重新连接 GitHub', 'error');
        // 本地 Token 与用户信息被清空
        expect(service.settings.token).toBeNull();
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_TOKEN]: null,
            [STORAGE_KEYS.CLOUD_USER_INFO]: null
        }));
    });

    it('sync 收到 401（已缓存 gistId）时同样清空 Token 并提示重新连接', async () => {
        // 已缓存 gistId 时 getGistFileContent 的 401 被 findOrCreateGist 捕获后继续走 listGists，
        // listGists 再次 401，provider 抛出「Token 已失效」，sync 捕获后统一清空本地 Token
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Bad credentials' }, 401)));

        const result = await service.sync();

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('同步失败：Token 已失效，请重新连接 GitHub', 'error');
        expect(service.settings.token).toBeNull();
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_TOKEN]: null
        }));
    });

    it('sync 收到 403 频率限制时提示稍后再试', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'API rate limit exceeded' }, 403)));

        const result = await service.sync();

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('同步失败：GitHub API 频率限制，请稍后再试', 'error');
    });

    it('sync 其他 HTTP 错误时提示状态码与消息', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        // getGist 失败后 findOrCreateGist 会尝试 listGists，全部返回 500
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ message: 'Server Error' }, 500)));

        const result = await service.sync();

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith('同步失败：Server Error (500)', 'error');
    });

    // ==================== init() 启动同步 ====================

    it('init 在已登录且开启自动同步时执行静默双向同步', async () => {
        const { service, storage, dataManager, ui } = createService();
        // 远端比本地多一个站点，启动同步应静默拉取合并
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.CLOUD_AUTO_SYNC]: true,
            ...seedMergeFixture([app('a1', 'A')], [app('a1', 'A')])
        });
        const remoteData = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A'), app('r1', '远端新增')] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        };
        vi.stubGlobal('fetch', vi.fn((url: string) => {
            if (url.includes('/user')) {
                return Promise.resolve(createResponse({ login: 'tester', id: 1, avatar_url: 'https://avatar.png' }));
            }
            return Promise.resolve(createGistResponse(remoteData));
        }));

        await service.init();

        // 合并结果应用到本地（不弹确认、静默无 Toast）
        expect(dataManager.applyStorageSnapshot).toHaveBeenCalledWith(remoteData);
        expect(service.settings.lastSyncTime).toBeGreaterThan(0);
        expect(ui.showToast).not.toHaveBeenCalled();
        expect(ui.showConfirm).not.toHaveBeenCalled();
    });

    it('init 未开启自动同步时仅验证 Token，不发起同步', async () => {
        const { service, storage, dataManager } = createService();
        await seedSignedIn(service, storage);
        const fetchMock = vi.fn((_url: string) =>
            Promise.resolve(createResponse({ login: 'tester', id: 1, avatar_url: 'https://avatar.png' }))
        );
        vi.stubGlobal('fetch', fetchMock);

        await service.init();

        // 仅调用 /user 验证，未访问 Gist
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('/user');
        expect(dataManager.syncNow).not.toHaveBeenCalled();
    });

    // ==================== upload() 全量上传 ====================

    it('upload 成功后用上传内容更新 base 快照', async () => {
        const { service, storage, ui } = createService();
        const localData: AppNavigatorData = { categories: [], apps: [app('a1', 'A')] };
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: localData,
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
        const fetchMock = stubSyncFetch({});

        const result = await service.upload();

        expect(result.success).toBe(true);
        expect(hasPatchCall(fetchMock)).toBe(true);
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: {
                [STORAGE_KEYS.MAIN_DATA]: localData,
                [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
            },
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: expect.any(Number)
        }));
        expect(ui.showToast).toHaveBeenCalledWith('数据已同步到 GitHub', 'success');
    });

    it('upload 失败时即使 silent 也提示同步失败', async () => {
        const { service, storage, ui } = createService();
        await seedSignedIn(service, storage);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        const result = await service.upload({ silent: true });

        expect(result.success).toBe(false);
        expect(ui.showToast).toHaveBeenCalledWith(
            '同步失败：无法连接 GitHub，请检查网络或代理（国内可能需代理访问）',
            'error'
        );
    });

    // ==================== 多平台（GitHub / Gitee）行为 ====================

    /** mock Gitee 平台请求：/user 验证、listGists 返回空、POST 创建 Gist */
    function stubGiteeFetch() {
        return vi.fn((url: string, init?: RequestInit) => {
            if (url.includes('/user')) {
                return Promise.resolve(createResponse({ login: 'gitee_user', id: 2, avatar_url: 'https://avatar2.png' }));
            }
            if (init?.method === 'POST') {
                return Promise.resolve(createResponse({ id: 'gitee_gist_1' }));
            }
            return Promise.resolve(createResponse([]));
        });
    }

    it('saveToken 指定 gitee 平台时走 Gitee API 并持久化 provider 键', async () => {
        const { service, storage } = createService();
        const fetchMock = stubGiteeFetch();
        vi.stubGlobal('fetch', fetchMock);

        const result = await service.saveToken('gitee_token', 'gitee');

        expect(result).toBe(true);
        // Token 验证请求发往 Gitee，且通过 query 传 access_token
        const [firstUrl] = fetchMock.mock.calls[0] as [string];
        expect(firstUrl).toContain('https://gitee.com/api/v5/user');
        expect(firstUrl).toContain('access_token=gitee_token');
        // provider 持久化并反映到设置快照
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_PROVIDER]: 'gitee'
        }));
        expect(service.settings.provider).toBe('gitee');
        expect(service.settings.userInfo?.login).toBe('gitee_user');
    });

    it('切换平台时重置 gistId / lastSyncTime 并将 base 快照置 null', async () => {
        const { service, storage } = createService();
        // 已以 GitHub 登录并有过同步记录
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: 123456,
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: {
                [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
                [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
            }
        });
        vi.stubGlobal('fetch', stubGiteeFetch());

        const result = await service.saveToken('gitee_token', 'gitee');

        expect(result).toBe(true);
        // 旧平台的 base 快照被清空，避免新平台空远端被误判为「远端删除全部」
        expect(storage.set).toHaveBeenCalledWith(STORAGE_KEYS.CLOUD_SYNC_BASE, null);
        // gistId 与 lastSyncTime 重置（saveSettings 时点上为 null / 0）
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_PROVIDER]: 'gitee',
            [STORAGE_KEYS.CLOUD_GIST_ID]: null,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: 0
        }));
        // 新平台完成 findOrCreateGist 后使用新 Gist
        expect(service.settings.gistId).toBe('gitee_gist_1');
    });

    it('loadSettings 无 provider 记录但有 token 时默认 github（兼容老用户）', async () => {
        const { service, storage } = createService();
        await storage.set(STORAGE_KEYS.CLOUD_TOKEN, TEST_TOKEN);
        await service.loadSettings();

        expect(service.settings.provider).toBe('github');
    });

    it('logout 清空 provider 与 base 快照', async () => {
        const { service, storage } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.CLOUD_PROVIDER]: 'gitee',
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: {
                [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
                [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
            }
        });
        expect(service.settings.provider).toBe('gitee');

        await service.logout();

        expect(service.settings.token).toBeNull();
        expect(service.settings.provider).toBe('github');
        expect(storage.set).toHaveBeenCalledWith(STORAGE_KEYS.CLOUD_SYNC_BASE, null);
        expect(storage.setMany).toHaveBeenCalledWith(expect.objectContaining({
            [STORAGE_KEYS.CLOUD_TOKEN]: null,
            [STORAGE_KEYS.CLOUD_PROVIDER]: 'github'
        }));
    });
});

/**
 * 资源通道：大对象拆成 content-addressed 分片
 * 主文件只留引用，图标/壁纸正文按内容哈希单独成文件，
 * 于是同步包不再受「详情接口 1MB 内联」和单文件上限的双重挤压。
 */
describe('CloudSyncService 资源通道', () => {
    const ICON = `data:image/png;base64,${'QUJDRA'.repeat(40)}`;

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /**
     * 按调用次序返回 Gist 详情，并记录 PATCH 请求体。
     * 云端主同步文件始终存在——否则 findOrCreateGist 会认为本地 gistId 已失效，
     * 转去 listGists/createGist，测的就不是资源通道了。
     */
    function stubUploadFetch(remoteAssetFiles: Record<string, unknown> = {}) {
        const patchBodies: Array<Record<string, unknown>> = [];
        const files = {
            [SYNC_FILE_NAME]: { content: JSON.stringify({ version: '1.0', data: {} }) },
            ...remoteAssetFiles
        };
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                patchBodies.push(JSON.parse(init.body as string).files);
                return createResponse({ id: TEST_GIST_ID });
            }
            return createResponse({ id: TEST_GIST_ID, files });
        });
        vi.stubGlobal('fetch', fetchMock);
        return { fetchMock, patchBodies };
    }

    /** 取 PATCH 里的主文件内容 */
    function mainFileContent(files: Record<string, unknown>): string {
        const entry = files[SYNC_FILE_NAME] as { content: string };
        return entry.content;
    }

    it('upload 把 Base64 图标换成引用，正文另存为分片文件', async () => {
        const { service, storage } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [{ id: 'a1', name: '站点', url: 'https://a.test', icon: ICON }] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
        const { patchBodies } = stubUploadFetch({});

        await service.upload({ silent: true });

        const files = patchBodies[0];
        const syncData = JSON.parse(mainFileContent(files)) as {
            version: string;
            data: Record<string, unknown>;
            assets?: Record<string, { mime: string; files: string[] }>;
        };
        expect(syncData.version).toBe('1.1');
        expect(syncData.assets).toBeDefined();
        expect(mainFileContent(files)).not.toContain('data:image/png;base64');
        const [key, entry] = Object.entries(syncData.assets!)[0];
        expect(entry.mime).toBe('image/png');
        expect(entry.files.every(name => name.startsWith('haha-asset-'))).toBe(true);
        expect((files[entry.files[0]] as { content: string }).content).toBe(
            ICON.slice('data:image/png;base64,'.length)
        );
        expect(key).toBe(entry.files[0].replace(/^haha-asset-/, '').replace(/-0\.txt$/, ''));
    });

    it('云端已有的同内容分片不重传，不再引用的分片被删除', async () => {
        const packed = await externalizeAssets({ icon: ICON }, 8 * 1024 * 1024);
        const keepName = Object.keys(packed.chunks)[0];

        const { service, storage } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [{ id: 'a1', name: '站点', url: 'https://a.test', icon: ICON }] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });
        const { patchBodies } = stubUploadFetch({
            [keepName]: { content: packed.chunks[keepName] },
            'haha-asset-gone-0.txt': { content: 'STALE' }
        });

        await service.upload({ silent: true });

        const files = patchBodies[0];
        expect(keepName in files).toBe(false);
        expect(files['haha-asset-gone-0.txt']).toBeNull();
    });

    it('sync 先把云端引用还原成 data URL，再交给校验与合并', async () => {
        const packed = await externalizeAssets(
            {
                [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [{ id: 'a1', name: '站点', url: 'https://a.test', icon: ICON }] },
                [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
            },
            8 * 1024 * 1024
        );
        const syncData = {
            version: '1.1',
            lastModified: 1700000000000,
            device: 'Chrome',
            data: packed.data,
            assets: packed.manifest
        };
        const files: Record<string, unknown> = {
            [SYNC_FILE_NAME]: { content: JSON.stringify(syncData) }
        };
        for (const [name, content] of Object.entries(packed.chunks)) {
            files[name] = { content };
        }
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ id: TEST_GIST_ID, files })));

        const { service, storage, dataManager } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });

        const result = await service.sync({ silent: true });

        expect(result.success).toBe(true);
        expect(result.applied).toBe(true);
        const snapshot = (dataManager.applyStorageSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, AppNavigatorData>;
        expect(snapshot[STORAGE_KEYS.MAIN_DATA].apps[0].icon).toBe(ICON);
    });

    it('分片缺失时不判坏整份数据：引用原样交给本地，同步照常完成', async () => {
        const packed = await externalizeAssets(
            {
                [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [{ id: 'a1', name: '站点', url: 'https://a.test', icon: ICON }] },
                [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
            },
            8 * 1024 * 1024
        );
        const files: Record<string, unknown> = {
            [SYNC_FILE_NAME]: {
                content: JSON.stringify({
                    version: '1.1',
                    lastModified: 1700000000000,
                    device: 'Chrome',
                    data: packed.data,
                    assets: packed.manifest
                })
            }
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({ id: TEST_GIST_ID, files })));

        const { service, storage, dataManager } = createService();
        await seedSignedIn(service, storage, {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [] },
            [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB
        });

        const result = await service.sync({ silent: true });

        expect(result.success).toBe(true);
        const snapshot = (dataManager.applyStorageSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, AppNavigatorData>;
        expect(String(snapshot[STORAGE_KEYS.MAIN_DATA].apps[0].icon).startsWith('haha-asset://')).toBe(true);
    });
});
