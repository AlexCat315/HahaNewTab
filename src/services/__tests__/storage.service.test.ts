import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserAPI } from '@/services/browserApi.service';
import { BOOT_SNAPSHOT_KEY } from '@/services/storageSchema.service';
import { readBootSnapshotValue, writeBootSnapshotValue } from '@/test/bootSnapshot';
import {
    StorageManager,
    storageManager,
    STORAGE_KEYS,
    STORAGE_EVENT,
    SYNC_MIRROR_KEYS,
} from '@/services/storage.service';

describe('StorageManager', () => {
    beforeEach(() => {
        localStorage.clear();
        // 模拟非扩展环境：确保 window.chrome/browser 不存在
        delete (window as unknown as { chrome?: unknown }).chrome;
        delete (window as unknown as { browser?: unknown }).browser;
        BrowserAPI.resetDetection();
    });

    it('应能写入并读取单个值', async () => {
        const manager = new StorageManager();
        await manager.set('foo', { bar: 1 });
        const value = await manager.get('foo');
        expect(value).toEqual({ bar: 1 });
    });

    it('应能批量写入并读取', async () => {
        const manager = new StorageManager();
        await manager.setMany({ a: 1, b: 'text' });
        const values = await manager.getMany(['a', 'b', 'c']);
        expect(values).toEqual({ a: 1, b: 'text', c: null });
    });

    it('应能删除存储项', async () => {
        const manager = new StorageManager();
        await manager.set('toDelete', 'value');
        await manager.remove('toDelete');
        const value = await manager.get('toDelete');
        expect(value).toBeNull();
    });

    it('读取不存在的键应返回 null', async () => {
        const manager = new StorageManager();
        const value = await manager.get('nonexistent');
        expect(value).toBeNull();
    });

    it('返回值应为深拷贝，修改不影响存储', async () => {
        const manager = new StorageManager();
        const original = { list: [1, 2] };
        await manager.set('original', original);
        const fetched = (await manager.get('original')) as { list: number[] };
        fetched.list.push(3);
        const again = (await manager.get('original')) as { list: number[] };
        expect(again.list).toEqual([1, 2]);
    });

    it('首帧键应写入 __boot__ 快照', async () => {
        const manager = new StorageManager();
        await manager.set(STORAGE_KEYS.SELECTED_THEME, 'material-rose');

        expect(readBootSnapshotValue(STORAGE_KEYS.SELECTED_THEME)).toBe('material-rose');
        expect(SYNC_MIRROR_KEYS).toContain(STORAGE_KEYS.SELECTED_THEME);
    });

    it('布局设置属于首帧键（极简约模式首帧不闪的前提）', () => {
        expect(SYNC_MIRROR_KEYS).toContain(STORAGE_KEYS.LAYOUT_SETTINGS);
    });

    it('getSync 优先读快照；快照存在时不再看旧版逐键镜像', () => {
        const manager = new StorageManager();
        writeBootSnapshotValue(STORAGE_KEYS.SELECTED_THEME, 'from-boot');
        localStorage.setItem(STORAGE_KEYS.SELECTED_THEME, '"from-legacy"');

        expect(manager.getSync(STORAGE_KEYS.SELECTED_THEME)).toBe('from-boot');
    });

    it('还没有快照时 getSync 兜底读旧版逐键镜像（升级首帧不闪）', () => {
        const manager = new StorageManager();
        localStorage.setItem(STORAGE_KEYS.SELECTED_THEME, '"legacy-theme"');

        expect(manager.getSync(STORAGE_KEYS.SELECTED_THEME)).toBe('legacy-theme');
    });

    it('writeSyncMirror 只写快照，不写后端存储', () => {
        const manager = new StorageManager();
        const backendSet = vi.spyOn(BrowserAPI.storage.local, 'set');

        manager.writeSyncMirror(STORAGE_KEYS.LAYOUT_SETTINGS, { minimalMode: true });

        expect(readBootSnapshotValue(STORAGE_KEYS.LAYOUT_SETTINGS)).toEqual({ minimalMode: true });
        expect(backendSet).not.toHaveBeenCalled();
        backendSet.mockRestore();
    });

    it('writeSyncMirror 对非首帧键静默忽略', () => {
        const manager = new StorageManager();
        manager.writeSyncMirror('someRandomKey', { a: 1 });

        expect(localStorage.getItem('someRandomKey')).toBeNull();
        expect(readBootSnapshotValue('someRandomKey')).toBeNull();
    });

    it('writeSyncMirror 在 localStorage 抛错时不向外冒泡', () => {
        const manager = new StorageManager();
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(() => manager.writeSyncMirror(STORAGE_KEYS.LAYOUT_SETTINGS, { minimalMode: true })).not.toThrow();
        expect(warn).toHaveBeenCalled();

        spy.mockRestore();
        warn.mockRestore();
    });

    it('首帧键写入失败时应回滚快照', async () => {
        const manager = new StorageManager();
        writeBootSnapshotValue(STORAGE_KEYS.SELECTED_THEME, 'old-theme');

        // 第一次 setItem 写快照，第二次是后端持久化（网页环境落在 localStorage）→ 让它失败
        const originalSetItem = localStorage.setItem.bind(localStorage);
        let callCount = 0;
        const setItemSpy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                callCount++;
                if (callCount === 2) {
                    throw new Error('QuotaExceededError');
                }
                return originalSetItem.call(this, key, value);
            });

        try {
            await expect(manager.set(STORAGE_KEYS.SELECTED_THEME, 'new-theme')).rejects.toThrow();
            expect(readBootSnapshotValue(STORAGE_KEYS.SELECTED_THEME)).toBe('old-theme');
        } finally {
            setItemSpy.mockRestore();
        }
    });

    it('快照写入失败后应整体撤掉快照', async () => {
        const manager = new StorageManager();

        const originalSetItem = localStorage.setItem.bind(localStorage);
        let callCount = 0;
        const setItemSpy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                callCount++;
                if (callCount === 2) {
                    throw new Error('QuotaExceededError');
                }
                return originalSetItem.call(this, key, value);
            });

        try {
            await expect(manager.set(STORAGE_KEYS.SELECTED_THEME, 'new-theme')).rejects.toThrow();
            expect(localStorage.getItem(BOOT_SNAPSHOT_KEY)).toBeNull();
        } finally {
            setItemSpy.mockRestore();
        }
    });

    it('订阅应能监听到本地存储事件', async () => {
        const manager = new StorageManager();
        const listener = vi.fn();
        const unsubscribe = manager.subscribe(listener);

        await manager.set('eventKey', 'eventValue');

        expect(listener).toHaveBeenCalled();
        const changes = listener.mock.calls[0][0] as Record<string, { newValue: unknown }>;
        expect(changes.eventKey?.newValue).toBe('eventValue');

        unsubscribe();
    });

    it('取消订阅后不应再收到事件', async () => {
        const manager = new StorageManager();
        const listener = vi.fn();
        const unsubscribe = manager.subscribe(listener);
        unsubscribe();

        await manager.set('afterUnsub', 123);

        expect(listener).not.toHaveBeenCalled();
    });

    it('手动触发的 storage 事件也应被订阅接收', () => {
        const manager = new StorageManager();
        const listener = vi.fn();
        const unsubscribe = manager.subscribe(listener);

        window.dispatchEvent(
            new StorageEvent('storage', {
                key: 'manualKey',
                newValue: '"manualValue"',
                oldValue: null,
            })
        );

        expect(listener).toHaveBeenCalled();
        const changes = listener.mock.calls[0][0] as Record<string, { newValue: unknown }>;
        expect(changes.manualKey?.newValue).toBe('manualValue');

        unsubscribe();
    });

    it('导出常量应符合约定键名', () => {
        expect(STORAGE_KEYS.MAIN_DATA).toBe('appNavigator_data');
        expect(STORAGE_KEYS.USER_UI_LIB).toBe('appNavigator_user_uiLib');
        expect(STORAGE_KEYS.DATA_UPDATED_AT).toBe('appNavigator_dataUpdatedAt');
        expect(STORAGE_EVENT).toBe('haha-storage-change');
    });

    it('单例应可正常使用', async () => {
        await storageManager.set('singletonKey', 'singletonValue');
        const value = await storageManager.get('singletonKey');
        expect(value).toBe('singletonValue');
    });
});
