/**
 * 云同步设置模块的单测
 *
 * 这里只验「状态所有权」：谁能改这六项、改完通知谁、别的页面改了怎么跟上、
 * 写失败时内存是否停在原地。网络与合并都不在这层的职责里。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudSettings, emptySettings } from '../settings';
import { STORAGE_KEYS } from '@/types/storage';
import type { StorageChanges, StorageValue } from '@/types/storage';

class FakeStorage {
    /** 已落盘的键值 */
    readonly items: Record<string, StorageValue> = {};
    /** 每次 setMany 收到的载荷，用于断言「只写了变化的那几项」 */
    readonly writes: Record<string, StorageValue>[] = [];
    private readonly listeners: ((changes: StorageChanges) => void)[] = [];

    /** 关掉某次写入的落盘能力即可模拟存储失败 */
    failNextWrite: Error | null = null;

    getMany = async (keys: string[]): Promise<Record<string, StorageValue>> => {
        const result: Record<string, StorageValue> = {};
        for (const key of keys) {
            // 与存储内核一致：没写过的键也给回 null，而不是干脆不出现
            result[key] = this.items[key] ?? null;
        }
        return result;
    };

    setMany = async (items: Record<string, StorageValue>): Promise<void> => {
        this.writes.push({ ...items });
        if (this.failNextWrite) {
            const error = this.failNextWrite;
            this.failNextWrite = null;
            throw error;
        }
        Object.assign(this.items, items);
        // 与存储内核一致：写完同步派发给所有订阅者（含自己）
        const changes: StorageChanges = {};
        for (const [key, value] of Object.entries(items)) {
            changes[key] = { newValue: value };
        }
        for (const listener of [...this.listeners]) {
            listener(changes);
        }
    };

    subscribe = (listener: (changes: StorageChanges) => void): (() => void) => {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) this.listeners.splice(index, 1);
        };
    };

    /** 别的标签页写了一次存储：本页面只收到变更事件，本机数据由对端维护 */
    emitFromOtherPage(changes: StorageChanges): void {
        for (const listener of [...this.listeners]) {
            listener(changes);
        }
    }
}

let storage: FakeStorage;
let settings: CloudSettings;

beforeEach(() => {
    storage = new FakeStorage();
    settings = new CloudSettings(storage);
});

describe('CloudSettings.load', () => {
    it('读回已落盘的设置', async () => {
        Object.assign(storage.items, {
            [STORAGE_KEYS.CLOUD_TOKEN]: 'ghp_abc',
            [STORAGE_KEYS.CLOUD_GIST_ID]: 'gist_1',
            [STORAGE_KEYS.CLOUD_AUTO_SYNC]: true,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: 1234,
            [STORAGE_KEYS.CLOUD_PROVIDER]: 'gitee'
        });

        const loaded = await settings.load();

        expect(loaded).toEqual({
            token: 'ghp_abc',
            gistId: 'gist_1',
            autoSync: true,
            userInfo: null,
            provider: 'gitee'
        });
        expect(settings.isLoggedIn()).toBe(true);
    });

    it('从未写入过的键退回空设置而不是 undefined', async () => {
        expect(await settings.load()).toEqual(emptySettings());
        expect(settings.isLoggedIn()).toBe(false);
    });

    it('脏值收敛：开关只认真 true', async () => {
        storage.items[STORAGE_KEYS.CLOUD_AUTO_SYNC] = 'yes';
        await settings.load();
        // 字符串「yes」看着像开启，但自动同步是会往云端写数据的开关，不能靠猜
        expect(settings.get().autoSync).toBe(false);

        settings.applyExternal({ [STORAGE_KEYS.CLOUD_AUTO_SYNC]: { newValue: 'yes' } });
        expect(settings.get().autoSync).toBe(false);
    });
});

describe('CloudSettings.save', () => {
    it('只写真的变化了的那几项', async () => {
        await settings.save({ token: 'ghp_abc', gistId: 'gist_1' });
        storage.writes.length = 0;

        await settings.save({ gistId: 'gist_2' });

        expect(storage.writes).toHaveLength(1);
        expect(Object.keys(storage.writes[0])).toEqual([STORAGE_KEYS.CLOUD_GIST_ID]);
    });

    it('值没变时一个字节都不写，也不通知订阅者', async () => {
        await settings.save({ autoSync: true });
        const listener = vi.fn();
        settings.watch(listener);
        storage.writes.length = 0;

        const delta = await settings.save({ autoSync: true });

        expect(delta.changed).toBe(false);
        expect(storage.writes).toHaveLength(0);
        expect(listener).not.toHaveBeenCalled();
    });

    /**
     * 旧实现每次 saveSettings 都全量写六项，于是「只改了一个 Gist」
     * 也会把 Token 重新广播一遍，逼着每个订阅者再对一次账。
     */
    it('改 Gist 不该重新写 Token', async () => {
        await settings.save({ token: 'ghp_abc' });
        storage.writes.length = 0;

        await settings.save({ gistId: 'gist_new' });

        expect(storage.writes[0]).not.toHaveProperty(STORAGE_KEYS.CLOUD_TOKEN);
    });

    it('落盘失败时内存不前进，避免和存储分叉', async () => {
        storage.failNextWrite = new Error('Quota exceeded');

        await expect(settings.save({ token: 'ghp_abc' })).rejects.toThrow('Quota exceeded');

        expect(settings.get().token).toBeNull();
    });

    it('写入成功后通知订阅者', async () => {
        const seen: string[] = [];
        settings.watch((snapshot, delta) => {
            seen.push(`${snapshot.token}:${delta.authChanged}`);
        });

        await settings.save({ token: 'ghp_abc' });

        expect(seen).toEqual(['ghp_abc:true']);
    });

    /**
     * 落盘期间内核会把这次写入原样通知回来，而那时内存还没前进。
     * 认不出这条回声就会把本机自己的登录当成「别的页面改了设置」，
     * 一次写入通知两遍，诊断日志也跟着说谎。
     */
    it('自己的写入不会把自己当成别的页面', async () => {
        settings.observe();
        const fromOtherPage: boolean[] = [];
        settings.watch((_snapshot, delta) => fromOtherPage.push(delta.fromOtherPage));

        await settings.save({ token: 'ghp_abc' });

        expect(fromOtherPage).toEqual([false]);
    });
});

describe('CloudSettings.applyExternal', () => {
    it('别的页面登录后本页拿到 Token', async () => {
        await settings.load();
        settings.observe();
        storage.emitFromOtherPage({
            [STORAGE_KEYS.CLOUD_TOKEN]: { newValue: 'ghp_from_other_tab' },
            [STORAGE_KEYS.CLOUD_GIST_ID]: { newValue: 'gist_other_tab' },
            [STORAGE_KEYS.CLOUD_USER_INFO]: { newValue: { login: 'someone', id: 1, avatar: '' } }
        });

        expect(settings.isLoggedIn()).toBe(true);
        expect(settings.get().gistId).toBe('gist_other_tab');
        expect(settings.get().userInfo).toEqual({ login: 'someone', id: 1, avatar: '' });
    });

    /** 换账号最容易出的事：Token 是新的，Gist 还是上一个账号的 */
    it('换账号时这一批没带的派生字段直接清空', async () => {
        await settings.save({ token: 'ghp_old', gistId: 'gist_old', userInfo: { login: 'old', id: 1, avatar: '' } });

        const delta = await Promise.resolve(settings.applyExternal({
            [STORAGE_KEYS.CLOUD_TOKEN]: { newValue: 'ghp_new' }
        }));

        const snapshot = settings.get();
        expect(delta.authChanged).toBe(true);
        expect(snapshot.token).toBe('ghp_new');
        expect(snapshot.gistId).toBeNull();
        expect(snapshot.userInfo).toBeNull();
    });

    it('同一个值重复通知不该产生变化，也不会回写', async () => {
        storage.items[STORAGE_KEYS.CLOUD_TOKEN] = 'ghp_same';
        await settings.load();
        const listener = vi.fn();
        settings.watch(listener);
        storage.writes.length = 0;

        // 自己的写入也会回到自己手上：值一致时必须当成「没发生事」
        settings.applyExternal({ [STORAGE_KEYS.CLOUD_TOKEN]: { newValue: 'ghp_same' } });

        expect(listener).not.toHaveBeenCalled();
        expect(storage.writes).toHaveLength(0);
    });

    it('与本次无关的键不参与判定', () => {
        const delta = settings.applyExternal({ [STORAGE_KEYS.MAIN_DATA]: { newValue: {} } });
        expect(delta.changed).toBe(false);
    });

    it('Token 被对端清空时本页跟着退出登录', async () => {
        settings.applyExternal({ [STORAGE_KEYS.CLOUD_TOKEN]: { newValue: 'ghp_a' } });
        expect(settings.isLoggedIn()).toBe(true);

        settings.applyExternal({ [STORAGE_KEYS.CLOUD_TOKEN]: { newValue: null } });

        expect(settings.isLoggedIn()).toBe(false);
    });
});

describe('CloudSettings.observe', () => {
    it('订阅后跨页改动自动采纳，取消订阅后不再响应', async () => {
        await settings.load();
        const stop = settings.observe();

        storage.emitFromOtherPage({ [STORAGE_KEYS.CLOUD_AUTO_SYNC]: { newValue: true } });
        expect(settings.get().autoSync).toBe(true);

        stop();
        storage.emitFromOtherPage({ [STORAGE_KEYS.CLOUD_AUTO_SYNC]: { newValue: false } });
        expect(settings.get().autoSync).toBe(true);
    });

    it('observe 重复调用只挂一个订阅，避免一次变更通知两遍', async () => {
        const spy = vi.spyOn(storage, 'subscribe');
        settings.observe();
        settings.observe();
        settings.observe();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
