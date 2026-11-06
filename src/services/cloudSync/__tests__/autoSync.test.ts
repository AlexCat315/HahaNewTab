/**
 * 自动同步调度器测试
 * 覆盖：变更名单过滤、防抖合并、回写云端期间的抑制、未就绪时不排程、
 * 失败后的最小重试与额度、新一轮用户改动重新给满额度、stop 撤销待发与重试。
 * 这里只测「什么时候再同步一次」；提示与界面状态在 cloudSync store 层测。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoSyncScheduler } from '@/services/cloudSync/autoSync';
import { STORAGE_KEYS } from '@/types/storage';
import type { StorageChanges } from '@/types/storage';
import type { SyncResult } from '@/types/cloudSync.types';

/** 同步范围内的键（与注册表登记一致） */
const SYNCED_KEY = STORAGE_KEYS.MAIN_DATA;
/** 不参与同步的设备本地态 */
const LOCAL_ONLY_KEY = STORAGE_KEYS.SIDEBAR_COLLAPSED;

function createHarness(options: {
    armed?: boolean;
    applyingRemote?: boolean;
    run?: () => Promise<SyncResult>;
} = {}) {
    const listeners: Array<(changes: StorageChanges) => void> = [];
    const settled: () => Promise<SyncResult> = async () => ({ success: true });
    const run = vi.fn(options.run ?? settled);
    const state = {
        armed: options.armed ?? true,
        applyingRemote: options.applyingRemote ?? false
    };
    const scheduler = new AutoSyncScheduler({
        subscribe: listener => {
            listeners.push(listener);
            return () => {
                const index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
        isArmed: () => state.armed,
        isApplyingRemoteData: () => state.applyingRemote,
        run
    });
    /** 模拟一次落盘通知 */
    const emit = (key: string): void => {
        for (const listener of [...listeners]) {
            listener({ [key]: { newValue: 'x' } });
        }
    };
    return { scheduler, listeners, run, emit, state };
}

describe('AutoSyncScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('监听挂上后，同步范围内的落盘会排一次自动同步', async () => {
        const { scheduler, emit, run } = createHarness();
        scheduler.start();

        emit(SYNCED_KEY);
        expect(run).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it('设备本地态落盘不排程', async () => {
        const { scheduler, emit, run } = createHarness();
        scheduler.start();

        emit(LOCAL_ONLY_KEY);
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).not.toHaveBeenCalled();

        scheduler.stop();
    });

    it('连续落盘只在停下来后同步一次（防抖）', async () => {
        const { scheduler, emit, run } = createHarness();
        scheduler.start();

        for (let i = 0; i < 3; i++) {
            emit(SYNCED_KEY);
            await vi.advanceTimersByTimeAsync(2000);
        }
        expect(run).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it('刚把云端结果写回本地的那次落盘不算本机改动', async () => {
        const { scheduler, emit, run, state } = createHarness();
        scheduler.start();

        state.applyingRemote = true;
        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(5000);
        expect(run).not.toHaveBeenCalled();

        // 写完之后本机自己再改，仍然照常排程
        state.applyingRemote = false;
        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it('未就绪（没登录或没开自动同步）时什么都不排', async () => {
        const { scheduler, emit, run, state } = createHarness({ armed: false });
        scheduler.start();

        emit(SYNCED_KEY);
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(5000);
        expect(run).not.toHaveBeenCalled();

        state.armed = true;
        scheduler.trigger();
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it('这一轮没送出去时按防抖时长补重试，额度用尽即停', async () => {
        const { scheduler, emit, run } = createHarness({
            run: async () => ({ success: false, retry: true })
        });
        scheduler.start();

        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000 * 5);

        // 首次 + 2 次重试；断网时不会无限重试下去
        expect(run).toHaveBeenCalledTimes(3);

        scheduler.stop();
    });

    it('成功的一轮不补重试', async () => {
        const { scheduler, emit, run } = createHarness();
        scheduler.start();

        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000 * 5);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it('同步抛错同样按「没送出去」补一轮', async () => {
        const { scheduler, emit, run } = createHarness({
            run: async () => {
                throw new Error('Storage full');
            }
        });
        scheduler.start();

        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000 * 5);

        // 首次 + 2 次重试，且不会因为抛错就无限补
        expect(run).toHaveBeenCalledTimes(3);

        scheduler.stop();
    });

    it('新的用户改动重新给满重试额度', async () => {
        const { scheduler, emit, run } = createHarness({
            run: async () => ({ success: false, retry: true })
        });
        scheduler.start();

        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000 * 5);
        expect(run).toHaveBeenCalledTimes(3);

        // 额度已空的这一轮之后，真的又有了一次编辑
        run.mockClear();
        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000 * 5);
        expect(run).toHaveBeenCalledTimes(3);

        scheduler.stop();
    });

    it('stop 撤销尚未发出的同步与重试', async () => {
        const { scheduler, emit, run } = createHarness({
            run: async () => ({ success: false, retry: true })
        });
        scheduler.start();

        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
        await vi.advanceTimersByTimeAsync(3000 * 3);
        expect(run).toHaveBeenCalledTimes(1);

        // 摘掉监听后的落盘不再排程
        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('重复 start 只挂一份监听', async () => {
        const { scheduler, listeners, emit, run } = createHarness();
        scheduler.start();
        scheduler.start();
        expect(listeners).toHaveLength(1);

        emit(SYNCED_KEY);
        await vi.advanceTimersByTimeAsync(3000);
        expect(run).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });
});
