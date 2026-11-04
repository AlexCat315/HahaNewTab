/**
 * 云同步数据管理器测试
 * 覆盖：写盘前刷入 appData 内存变更、按注册表归属把云端快照分发给各 owner store、
 * 未登记键不参与、空快照返回 false、云端写回不盖 DATA_UPDATED_AT。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { BrowserAPI } from '@/services/browserApi.service';
import { storageManager } from '@/services/storage.service';
import { STORAGE_KEYS } from '@/types/storage';
import type { AppNavigatorData } from '@/types/app';
import { createCloudSyncDataManager } from '@/stores/cloudSyncDataManager';
import { useAppDataStore } from '@/stores/appData.store';
import { useUiLibStore } from '@/stores/uiLib.store';
import { useThemeStore } from '@/stores/theme.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useSearchStore } from '@/stores/search.store';
import { useWallpaperStore } from '@/stores/wallpaper.store';

const MAIN_DATA: AppNavigatorData = {
    categories: [{ id: 'c1', name: '分类', icon: 'folder.svg' }],
    apps: [{ id: 'a1', name: '站点', url: 'https://example.com', category: 'c1' }]
};

/** 一份覆盖全部 owner 的云端快照 */
function fullSnapshot() {
    return {
        [STORAGE_KEYS.MAIN_DATA]: MAIN_DATA,
        [STORAGE_KEYS.USER_UI_LIB]: { categories: [{ id: 'uc', name: '图标集', url: 'https://icons.example' }], items: [] },
        [STORAGE_KEYS.SELECTED_THEME]: 'material-rose-dark',
        [STORAGE_KEYS.THEME_SETTINGS]: { followSystem: true, familyId: 'material-rose' },
        [STORAGE_KEYS.LAYOUT_SETTINGS]: {
            columns: 6,
            paginate: true,
            pageSize: 30,
            showAllCategory: true,
            allViewFlat: false,
            showIconBackground: true,
            minimalMode: false,
            openMode: 'new-tab'
        },
        [STORAGE_KEYS.SEARCH_HISTORY]: [{ query: '云端搜的', time: 2000 }],
        [STORAGE_KEYS.WALLPAPER]: {
            url: 'https://example.com/bg.jpg',
            opacity: 0.7,
            blur: 3,
            overlayOpacity: 0.1,
            isLocalImage: false
        },
        [STORAGE_KEYS.WALLPAPER_IMAGE]: {
            data: 'data:image/png;base64,AAA',
            name: 'bg.png',
            type: 'image/png',
            size: 3,
            timestamp: 1000
        }
    };
}

describe('createCloudSyncDataManager', () => {
    beforeEach(() => {
        localStorage.clear();
        delete (window as unknown as { chrome?: unknown }).chrome;
        delete (window as unknown as { browser?: unknown }).browser;
        BrowserAPI.resetDetection();
        setActivePinia(createPinia());
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('把各归属的键落到对应 store，同时写进存储', async () => {
        const manager = createCloudSyncDataManager();
        const snapshot = fullSnapshot();

        const applied = await manager.applyStorageSnapshot(snapshot);

        expect(applied).toBe(true);
        const appData = useAppDataStore();
        // 「全部应用」是兜底分类，normalizeMainData 会补齐
        expect(appData.categories.map(item => item.id)).toEqual(['all', 'c1']);
        expect(useUiLibStore().userUiLib?.categories.map(item => item.id)).toEqual(['uc']);
        const theme = useThemeStore();
        expect(theme.selectedThemeId).toBe('material-rose-dark');
        expect(theme.followSystem).toBe(true);
        expect(useLayoutStore().columns).toBe(6);
        expect(useSearchStore().history.map(item => item.query)).toEqual(['云端搜的']);
        const wallpaper = useWallpaperStore();
        expect(wallpaper.settings.blur).toBe(3);
        expect(wallpaper.imageData?.name).toBe('bg.png');

        const persisted = await storageManager.getMany(Object.keys(snapshot));
        expect(persisted[STORAGE_KEYS.SELECTED_THEME]).toBe('material-rose-dark');
        expect(persisted[STORAGE_KEYS.WALLPAPER_IMAGE]).toEqual(snapshot[STORAGE_KEYS.WALLPAPER_IMAGE]);
    });

    it('只给站点数据时不动其他 store', async () => {
        const manager = createCloudSyncDataManager();
        const layout = useLayoutStore();
        const wallpaper = useWallpaperStore();
        layout.setPageSize(99);
        await wallpaper.setUrl('https://example.com/mine.jpg');

        const applied = await manager.applyStorageSnapshot({ [STORAGE_KEYS.MAIN_DATA]: MAIN_DATA });

        expect(applied).toBe(true);
        expect(layout.pageSize).toBe(99);
        expect(wallpaper.settings.url).toBe('https://example.com/mine.jpg');
    });

    it('未登记的键与设备本地态不参与，返回 false', async () => {
        const manager = createCloudSyncDataManager();

        const applied = await manager.applyStorageSnapshot({
            [STORAGE_KEYS.SIDEBAR_COLLAPSED]: true,
            unknown_key: 'x'
        });

        expect(applied).toBe(false);
        expect(await storageManager.get(STORAGE_KEYS.SIDEBAR_COLLAPSED)).toBeNull();
    });

    it('云端写回不盖 DATA_UPDATED_AT（首次同步要靠它判断本机有没有编辑过）', async () => {
        await storageManager.set(STORAGE_KEYS.DATA_UPDATED_AT, 1234);
        const manager = createCloudSyncDataManager();

        await manager.applyStorageSnapshot(fullSnapshot());

        expect(await storageManager.get(STORAGE_KEYS.DATA_UPDATED_AT)).toBe(1234);
    });

    it('syncNow 先把 appData 的内存变更刷进存储', async () => {
        const manager = createCloudSyncDataManager();
        const appData = useAppDataStore();
        await appData.loadData();
        appData.data.categories.push({ id: 'c9', name: '未落盘的分类', icon: 'folder.svg' });

        await manager.syncNow();

        const saved = await storageManager.get(STORAGE_KEYS.MAIN_DATA) as AppNavigatorData;
        expect(saved.categories.map(item => item.id)).toContain('c9');
    });
});
