/**
 * 合并引擎单测
 * 这一层没有网络与存储，四条规则各自一条用例，直接调用就能定论：
 * 坏数据不合并 / 云端旧版本不倒灌 / 首次同步比时间 / 冲突本地优先。
 *
 * 三份数据都用同一组键（snap 出来）：合并结果按注册表逐键产出，
 * 少给一个键就会多出一个默认值，applied / uploaded 会被「谁都没写过的键」污染。
 */
import { describe, expect, it } from 'vitest';
import { assertRemoteUsable, planSync } from '@/services/cloudSync/engine';
import type { SyncPlanInput } from '@/services/cloudSync/engine';
import { STORAGE_KEYS } from '@/types/storage';
import type { AppNavigatorData } from '@/types/app';
import type { UserUiLib } from '@/types/ui';

const EMPTY_UI_LIB: UserUiLib = { categories: [], items: [] };

/** 一份完整得足以直接比对的快照 */
function snap(theme: string, history: unknown[] = []): Record<string, unknown> {
    const mainData: AppNavigatorData = { categories: [], apps: [] };
    return {
        [STORAGE_KEYS.MAIN_DATA]: mainData,
        [STORAGE_KEYS.USER_UI_LIB]: EMPTY_UI_LIB,
        [STORAGE_KEYS.SELECTED_THEME]: theme,
        [STORAGE_KEYS.SEARCH_HISTORY]: history
    };
}

const HISTORY_X = [{ query: 'x', time: 1 }];
const HISTORY_XY = [{ query: 'x', time: 1 }, { query: 'y', time: 2 }];

function plan(input: Partial<SyncPlanInput> & Pick<SyncPlanInput, 'local' | 'remote'>): SyncPlanInput {
    return {
        base: null,
        remoteIsNew: true,
        localUpdatedAt: 0,
        remoteLastModified: 0,
        ...input
    };
}

const theme = (snapshot: Record<string, unknown>): unknown => snapshot[STORAGE_KEYS.SELECTED_THEME];

describe('planSync', () => {
    it('本地与云端一致时既不用应用也不用上传', () => {
        const both = snap('a');
        const result = planSync(plan({ base: both, local: both, remote: both }));

        expect(result.merged).toEqual(both);
        expect(result.applied).toBe(false);
        expect(result.uploaded).toBe(false);
    });

    it('两端各改不同的键时合并结果两边都要', () => {
        const result = planSync(plan({
            base: snap('a', HISTORY_X),
            local: snap('b', HISTORY_X),
            remote: snap('a', HISTORY_XY)
        }));

        expect(theme(result.merged)).toBe('b');
        expect(result.merged[STORAGE_KEYS.SEARCH_HISTORY]).toHaveLength(2);
        expect(result.applied).toBe(true);
        expect(result.uploaded).toBe(true);
    });

    it('同一个键两端都改过时本地优先', () => {
        const result = planSync(plan({
            base: snap('a'),
            local: snap('b'),
            remote: snap('c')
        }));

        expect(theme(result.merged)).toBe('b');
        // 本地已经是合并结果，不需要写回；云端才需要
        expect(result.applied).toBe(false);
        expect(result.uploaded).toBe(true);
    });

    /**
     * 写后立读时 Gist 会有一分钟把刚上传的那版再返回一次。
     * 它和三方合并里「别的设备改了云端」完全同形，认不出来就会把本机刚改好的设置倒灌回去。
     */
    it('云端是本机已经见过的旧版本时用 base 顶替，不把本机改动改回去', () => {
        const result = planSync(plan({
            base: snap('a'),
            local: snap('b'),
            remote: snap('a'),
            remoteIsNew: false
        }));

        expect(result.remoteSide).toEqual(snap('a'));
        expect(result.merged).toEqual(snap('b'));
        expect(result.applied).toBe(false);
        expect(result.uploaded).toBe(true);
    });

    it('首次同步没有 base 可比时，云端写得更晚就采纳云端', () => {
        const result = planSync(plan({
            base: null,
            local: snap('b'),
            remote: snap('a'),
            localUpdatedAt: 1000,
            remoteLastModified: 2000
        }));

        expect(result.hasBase).toBe(false);
        expect(result.tieBreak).toBe('remote');
        expect(theme(result.merged)).toBe('a');
        expect(result.applied).toBe(true);
    });

    it('首次同步时本机编辑得更晚则保留本地', () => {
        const result = planSync(plan({
            base: null,
            local: snap('b'),
            remote: snap('a'),
            localUpdatedAt: 3000,
            remoteLastModified: 2000
        }));

        expect(result.tieBreak).toBe('local');
        expect(theme(result.merged)).toBe('b');
        expect(result.uploaded).toBe(true);
    });

    it('本地数据非法时中止：坏数据一旦被合并上传会盖掉云端的好数据', () => {
        expect(() => planSync(plan({
            local: { [STORAGE_KEYS.SELECTED_THEME]: 42 },
            remote: snap('a')
        }))).toThrow('本地');
    });

    it('云端数据非法时中止', () => {
        expect(() => planSync(plan({
            local: snap('a'),
            remote: { [STORAGE_KEYS.SELECTED_THEME]: 42 }
        }))).toThrow('云端');
    });
});

describe('assertRemoteUsable', () => {
    it('云端整份覆盖本地前先验结构', () => {
        expect(() => assertRemoteUsable({ [STORAGE_KEYS.MAIN_DATA]: { categories: 'broken' } }))
            .toThrow('云端');
        expect(() => assertRemoteUsable(snap('a'))).not.toThrow();
    });
});
