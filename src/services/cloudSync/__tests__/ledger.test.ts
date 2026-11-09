/**
 * 同步账本：三项作为一批写入、整批重置、已见版本裁剪
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncLedger } from '@/services/cloudSync/ledger';
import type { SyncRound } from '@/services/cloudSync/ledger';
import { STORAGE_KEYS } from '@/types/storage';
import type { StorageChanges, StorageValue } from '@/types/storage';

class FakeStorage {
    items: Record<string, StorageValue> = {};
    readonly listeners: ((changes: StorageChanges) => void)[] = [];

    get = async (key: string): Promise<StorageValue | null> => this.items[key] ?? null;
    setMany = async (items: Record<string, StorageValue>): Promise<void> => {
        Object.assign(this.items, items);
        const changes: StorageChanges = {};
        for (const [key, value] of Object.entries(items)) changes[key] = { newValue: value };
        for (const listener of [...this.listeners]) listener(changes);
    };
    subscribe = (listener: (changes: StorageChanges) => void): (() => void) => {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) this.listeners.splice(index, 1);
        };
    };
}

let storage: FakeStorage;
let ledger: SyncLedger;

beforeEach(() => {
    storage = new FakeStorage();
    ledger = new SyncLedger(storage);
});

describe('SyncLedger', () => {
    it('reset 一次清空基线、同步时间和已见版本', async () => {
        storage.items = {
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: { appNavigator_data: {} },
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: 123456,
            [STORAGE_KEYS.CLOUD_SYNC_SEEN_REVISIONS]: ['rev-a', 'rev-b']
        };
        await ledger.load();

        await ledger.reset();

        expect(storage.items[STORAGE_KEYS.CLOUD_SYNC_BASE]).toBeNull();
        expect(storage.items[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]).toBe(0);
        expect(storage.items[STORAGE_KEYS.CLOUD_SYNC_SEEN_REVISIONS]).toEqual([]);
        expect(ledger.lastSyncTime()).toBe(0);
    });

    it('commit 把新版本放在已见名单最前并去重', async () => {
        const round: SyncRound = {
            base: null,
            seenRevisions: ['rev-b', 'rev-a'],
            startedAt: 0
        };
        await ledger.commit(round, { appNavigator_data: {} }, 'rev-b', 999);

        expect(storage.items[STORAGE_KEYS.CLOUD_SYNC_SEEN_REVISIONS]).toEqual(['rev-b', 'rev-a']);
        expect(storage.items[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]).toBe(999);
        expect(ledger.lastSyncTime()).toBe(999);
    });

    it('isStale 认出下载期间别的页面又同步完一次', async () => {
        storage.items[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME] = 100;
        const round = await ledger.beginRound();
        expect(await ledger.isStale(round)).toBe(false);

        storage.items[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME] = 200;
        expect(await ledger.isStale(round)).toBe(true);
    });

    it('别的页面更新同步时间时跟随；自己写入的回声不重复通知', async () => {
        await ledger.load();
        ledger.observe();
        const seen: number[] = [];
        ledger.watch(time => seen.push(time));

        const changes: StorageChanges = {
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: { newValue: 500 }
        };
        for (const listener of [...storage.listeners]) listener(changes);

        expect(seen).toEqual([500]);
    });

    it('订阅可取消', async () => {
        const listener = vi.fn();
        const stop = ledger.watch(listener);
        stop();
        storage.items[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME] = 700;
        const changes: StorageChanges = {
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: { newValue: 700 }
        };
        for (const item of [...storage.listeners]) item(changes);
        expect(listener).not.toHaveBeenCalled();
    });
});
