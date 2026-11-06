/**
 * usePersistentSlice 的写入时序回归
 *
 * 写穿式持久化最怕两种交错：
 *   1. 读取还没回来，用户改动先落进了内存——读取结果铺回来会把改动抹掉；
 *   2. 落盘失败（配额、存储异常）——内存必须退回改动前，否则界面与存储从此对不上。
 * 这里用真实的 layout store / search store 走这两条路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useLayoutStore } from '@/stores/layout.store';
import { useSearchStore } from '@/stores/search.store';
import { storageManager } from '@/services/storage.service';
import { STORAGE_KEYS } from '@/types/storage';

const LAYOUT_KEY = STORAGE_KEYS.LAYOUT_SETTINGS;

describe('usePersistentSlice 写入时序', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('init 的异步读取晚于用户切换时，切换结果不被读回的旧值覆盖', async () => {
        await storageManager.setMany({ [LAYOUT_KEY]: { minimalMode: false } });

        const layoutStore = useLayoutStore();
        // 扩展冷启动时 storage.local 可慢到几百毫秒
        const realGetMany = storageManager.getMany.bind(storageManager);
        vi.spyOn(storageManager, 'getMany').mockImplementation(async keys => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return realGetMany(keys);
        });

        // 页面挂载时 init 发起异步读取（不 await），用户随即切换
        const pendingInit = layoutStore.init();
        await layoutStore.setMinimalMode(true);
        await pendingInit;

        expect(layoutStore.minimalMode).toBe(true);
        expect(await storageManager.get(LAYOUT_KEY)).toMatchObject({ minimalMode: true });
        // 首帧快照也跟着最新值，否则下次打开还会闪回旧设置
        expect(storageManager.getSync(LAYOUT_KEY)).toMatchObject({ minimalMode: true });
    });

    it('落盘失败时回滚内存，且不给「本机改过同步数据」盖章', async () => {
        const layoutStore = useLayoutStore();
        await layoutStore.init();

        await storageManager.set(STORAGE_KEYS.DATA_UPDATED_AT, 1234);
        vi.spyOn(storageManager, 'setMany').mockRejectedValueOnce(new Error('配额不足'));

        await expect(layoutStore.setMinimalMode(true)).rejects.toThrow('配额不足');

        expect(layoutStore.minimalMode).toBe(false);
        expect(await storageManager.get(STORAGE_KEYS.DATA_UPDATED_AT)).toBe(1234);
    });

    it('只改不参与云同步的键时不刷新 DATA_UPDATED_AT', async () => {
        const searchStore = useSearchStore();
        await searchStore.loadFromStorage();

        await storageManager.set(STORAGE_KEYS.DATA_UPDATED_AT, 1234);
        await searchStore.setSelectedEngineIndex(2);

        expect(searchStore.selectedEngineIndex).toBe(2);
        expect(await storageManager.get(STORAGE_KEYS.DATA_UPDATED_AT)).toBe(1234);

        // 同一份 slice 里参与同步的键改了就要盖章
        await searchStore.addHistory('qoder');
        expect(await storageManager.get(STORAGE_KEYS.DATA_UPDATED_AT)).not.toBe(1234);
    });
});
