/**
 * 自动同步的读取顺序回归
 *
 * 「切换极简约模式后又跳回去」的几条链路都在这里：真实 store + 真实存储内核 + 假 Gist，
 * 走完「改设置 → 落盘 → 自动同步 → 三方合并 → 写回本地」一整圈。
 * 断言的是修好之后的行为：本地改动必须留住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useLayoutStore } from '@/stores/layout.store';
import { CloudSyncService } from '@/services/cloudSync.service';
import { storageManager } from '@/services/storage.service';
import { createCloudSyncDataManager } from '@/stores/cloudSyncDataManager';
import { STORAGE_KEYS } from '@/types/storage';
import type { LayoutSettings } from '@/types/storage';
import type { CloudSyncDependencies, ICloudSyncUIAdapter } from '@/types/cloudSync.types';

const TOKEN = 'ghp_test';
const GIST_ID = 'gist_1';
const SYNC_FILE = 'haha-newtab-sync.json';
const LAYOUT_KEY = STORAGE_KEYS.LAYOUT_SETTINGS;

function layout(partial: Partial<LayoutSettings>): LayoutSettings {
    return {
        columns: 'auto',
        paginate: false,
        pageSize: 24,
        showAllCategory: true,
        allViewFlat: false,
        showIconBackground: true,
        minimalMode: false,
        openMode: 'new-tab',
        ...partial
    };
}

function jsonResponse(body: unknown): Response {
    return {
        status: 200,
        ok: true,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body))
    } as Response;
}

/**
 * 假 Gist：云端只存一份同步文件
 *
 * freeze() 用来复现「写完立读拿到旧文件」：现场日志实测本机上传成功后约 1 分钟内，
 * 下一次读到的还是上传前那一版（lastModified 与内容都停在旧值）。
 */
function createCloud(remoteData: Record<string, unknown>, remoteLastModified: number) {
    let content = JSON.stringify({
        version: '1.1',
        lastModified: remoteLastModified,
        device: 'Chrome',
        data: remoteData
    });
    let frozen = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body)) as { files: Record<string, { content: string }> };
            if (!frozen) {
                content = body.files[SYNC_FILE].content;
            }
            return jsonResponse({ id: GIST_ID });
        }
        if (url.endsWith('/user')) {
            return jsonResponse({ login: 'u', id: 1, avatar_url: '' });
        }
        if (url.endsWith('/gists') || url.includes('/gists?')) {
            return jsonResponse([]);
        }
        return jsonResponse({ id: GIST_ID, files: { [SYNC_FILE]: { content } } });
    }));

    return {
        get layout(): LayoutSettings {
            return (JSON.parse(content).data[LAYOUT_KEY] ?? {}) as LayoutSettings;
        },
        freeze(): void {
            frozen = true;
        },
        /** 换一个云端版本号：模拟别的设备真的写过了 */
        setLayout(next: LayoutSettings): void {
            const parsed = JSON.parse(content) as { lastModified: number; data: Record<string, unknown> };
            parsed.data[LAYOUT_KEY] = next;
            parsed.lastModified = Date.now();
            content = JSON.stringify({ version: '1.1', ...parsed });
            frozen = false;
        }
    };
}

const quietUI: ICloudSyncUIAdapter = {
    showToast: () => {},
    showConfirm: async () => true,
    showPrompt: async () => null
};

/** 起一个用真实存储内核的服务实例（等同于一个标签页自己的同步服务） */
function createService(storage: CloudSyncDependencies['storage'] = storageManager): CloudSyncService {
    return new CloudSyncService({
        storage,
        dataManager: createCloudSyncDataManager(),
        ui: quietUI
    });
}

async function seedCloudConfig(base: Record<string, unknown> | null): Promise<void> {
    await storageManager.setMany({
        [STORAGE_KEYS.CLOUD_TOKEN]: TOKEN,
        [STORAGE_KEYS.CLOUD_GIST_ID]: GIST_ID,
        [STORAGE_KEYS.CLOUD_AUTO_SYNC]: true,
        [LAYOUT_KEY]: layout({ minimalMode: false })
    });
    if (base) {
        await storageManager.set(STORAGE_KEYS.CLOUD_SYNC_BASE, base);
    }
}

describe('自动同步的读取顺序', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('有 base 时本地改动保留并上传', async () => {
        const cloud = createCloud({ [LAYOUT_KEY]: layout({ minimalMode: false }) }, Date.now() - 60_000);
        await seedCloudConfig({ [LAYOUT_KEY]: layout({ minimalMode: false }) });

        const layoutStore = useLayoutStore();
        const service = createService();
        await service.loadSettings();

        await layoutStore.setMinimalMode(true);
        await service.sync({ silent: true });

        expect(layoutStore.minimalMode).toBe(true);
        expect(cloud.layout.minimalMode).toBe(true);
    });

    it('本机没有 base（首次同步 / 重新登录）时，刚切换的设置不被云端旧值改回去', async () => {
        // 云端这份比本机上一次同步还早，但没有 base 可比，只能靠 DATA_UPDATED_AT 定方向
        const cloud = createCloud({ [LAYOUT_KEY]: layout({ minimalMode: false }) }, Date.now() - 1000);
        await seedCloudConfig(null);

        const layoutStore = useLayoutStore();
        const service = createService();
        await service.loadSettings();

        await layoutStore.setMinimalMode(true);
        await service.sync({ silent: true });

        expect(layoutStore.minimalMode).toBe(true);
        expect(cloud.layout.minimalMode).toBe(true);
    });

    it('云端确实比本机改得更晚时，仍然采纳云端', async () => {
        const cloud = createCloud({ [LAYOUT_KEY]: layout({ minimalMode: true }) }, Date.now());
        await seedCloudConfig(null);
        // 本机最后一次改动在云端之前
        await storageManager.set(STORAGE_KEYS.DATA_UPDATED_AT, Date.now() - 60_000);
        await storageManager.set(LAYOUT_KEY, layout({ minimalMode: false }));

        const layoutStore = useLayoutStore();
        const service = createService();
        await service.loadSettings();

        await service.sync({ silent: true });
        await layoutStore.init();

        expect(layoutStore.minimalMode).toBe(true);
        expect(cloud.layout.minimalMode).toBe(true);
    });

    it('别的标签页在这一轮下载期间同步完成时，本轮放弃并交给调用方重试', async () => {        const cloud = createCloud({ [LAYOUT_KEY]: layout({ minimalMode: false }) }, Date.now() - 60_000);
        const seededBase = { [LAYOUT_KEY]: layout({ minimalMode: false }) };
        await seedCloudConfig(seededBase);

        const layoutStore = useLayoutStore();

        await layoutStore.setMinimalMode(true);

        const tabA = createService();
        await tabA.loadSettings();
        await tabA.sync({ silent: true });

        // B 标签页：读到的 base 与上次同步时间是 A 写完之前的值（真实场景是它先发起这几步、
        // 在这几次网络往返里 A 才同步完），下载回来的云端又比这份 base 旧
        const staleSnapshot: Record<string, unknown> = {
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: seededBase,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: null
        };
        let reads = 0;
        const staleFirstReads: CloudSyncDependencies['storage'] = {
            get: async key => {
                // 下载前的三次预读（base / 上次同步时间 / 已见版本号）都返回旧值
                if (++reads <= 3) return staleSnapshot[key] ?? null;
                return storageManager.get(key);
            },
            getMany: keys => storageManager.getMany(keys),
            set: (key, value) => storageManager.set(key, value),
            setMany: items => storageManager.setMany(items)
        };
        const tabB = createService(staleFirstReads);
        await tabB.loadSettings();

        const resultB = await tabB.sync({ silent: true });

        expect(resultB.success).toBe(false);
        expect(resultB.retry).toBe(true);
        expect(layoutStore.minimalMode).toBe(true);
        expect(cloud.layout.minimalMode).toBe(true);
    });

    it('云端把本机刚合并过的旧版本再返回一次时，不用它把设置改回去', async () => {
        // 现场复现：切换 → 上传成功 → 3 秒后的下一轮自动同步又读到上传前那一版，
        // 旧值在三方合并里和「别的设备改过云端」同形，于是本地被倒灌回去
        const cloud = createCloud({ [LAYOUT_KEY]: layout({ minimalMode: true }) }, Date.now() - 1000);
        await seedCloudConfig({ [LAYOUT_KEY]: layout({ minimalMode: true }) });

        const layoutStore = useLayoutStore();
        const service = createService();
        await service.loadSettings();

        await layoutStore.setMinimalMode(false);
        cloud.freeze();

        const first = await service.sync({ silent: true });
        expect(layoutStore.minimalMode).toBe(false);
        expect(first.uploaded).toBe(true);

        // 关键一步：这一轮读到的还是上一轮已经合并过的旧文件（minimalMode: true）。
        // 它不能当「别的设备改过云端」，否则刚改好的设置被倒灌回去。
        await service.sync({ silent: true });
        expect(layoutStore.minimalMode).toBe(false);

        const base = (await storageManager.get(STORAGE_KEYS.CLOUD_SYNC_BASE)) as Record<string, unknown>;
        expect((base[LAYOUT_KEY] as LayoutSettings).minimalMode).toBe(false);
    });
    it('云端换了新版本号时照常采纳别的设备写的值', async () => {
        const cloud = createCloud({ [LAYOUT_KEY]: layout({ minimalMode: true }) }, Date.now() - 1000);
        await seedCloudConfig({ [LAYOUT_KEY]: layout({ minimalMode: true }) });

        const layoutStore = useLayoutStore();
        const service = createService();
        await service.loadSettings();

        await layoutStore.setMinimalMode(false);
        cloud.freeze();
        await service.sync({ silent: true });

        // 另一台设备真的写过了：内容变了，版本号也就变了
        cloud.setLayout(layout({ minimalMode: true }));
        const result = await service.sync({ silent: true });

        expect(result.applied).toBe(true);
        expect(layoutStore.minimalMode).toBe(true);
    });
});
