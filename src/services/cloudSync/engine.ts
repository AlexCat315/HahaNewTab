/**
 * 合并引擎：三方数据进来，「该怎么改本机、该怎么推云端」出去
 *
 * 这一层没有网络、没有存储、没有提示，因此它可以被直接调用着测：
 * 给定 base / 本地 / 云端 三份数据与两个时间戳，结论是唯一确定的。
 *
 * 规则只有一条主线的四种说法：
 *   - 坏数据不参与合并（任何一端非法都中止，合并上传会把好那一端覆盖掉）；
 *   - 云端那一版本机已经见过 → 当作没新内容，用 base 顶替它参与合并；
 *   - 首次同步没有 base，同 id 冲突无从比较 → 谁写得晚谁赢；
 *   - 冲突时本地优先（逐键策略见存储键注册表）。
 */

import {
    CLOUD_SYNC_DATA_KEYS,
    CLOUD_SYNC_KEY_STRATEGIES,
    findCloudSyncViolation,
    hasCloudSyncBase
} from '@/services/storageSchema.service';
import { deepEqual, mergeSnapshots } from '@/utils/syncMerge.util';
import type { MergeTieBreak, SyncSnapshot } from '@/utils/syncMerge.util';

/** 合并的输入：本轮基线 + 三份数据 + 两个判断依据 */
export interface SyncPlanInput {
    /** 上次同步落定的快照；首次同步为 null */
    base: SyncSnapshot | null;
    /** 本轮收集到的本地数据 */
    local: SyncSnapshot;
    /** 云端那一版（资源已还原） */
    remote: SyncSnapshot;
    /** 云端这一版是不是本机没见过的新内容 */
    remoteIsNew: boolean;
    /** 本机最后一次用户改动时间 */
    localUpdatedAt: number;
    /** 云端记录的写入时间 */
    remoteLastModified: number;
}

/** 合并的结论：这一轮要往两边各做什么 */
export interface SyncPlan {
    /** 双方合并后的结果，既是要写回本地的，也是要推上云端的 */
    merged: SyncSnapshot;
    /** 有内容需要写回本地 */
    applied: boolean;
    /** 有内容需要上传云端 */
    uploaded: boolean;
    /** 参与合并的云端那一侧（旧版本时就是 base） */
    remoteSide: SyncSnapshot;
    /** 首次同步时定方向用的赢家 */
    tieBreak: MergeTieBreak;
    /** 本机有没有可比的基线 */
    hasBase: boolean;
}

/**
 * 算出这一轮同步该做什么
 * @throws 任一端数据结构非法时中止，错误信息带着「本地/云端」方便直接念给用户
 */
export function planSync(input: SyncPlanInput): SyncPlan {
    assertBothSidesValid(input.local, input.remote);

    // 旧版本不参与合并：拿 base 顶替它，合并结果就退回本机当前状态
    const remoteSide = input.remoteIsNew ? input.remote : input.base ?? {};
    const hasBase = hasCloudSyncBase(input.base);

    // 首次同步没有 base，同 id 冲突无法判断哪端改过：改按「最后一次写入更晚」的一方胜出，
    // 否则新装设备那份出厂默认数据会把另一台已经改过的云端覆盖回去
    const tieBreak: MergeTieBreak =
        !hasBase && input.remoteLastModified > input.localUpdatedAt ? 'remote' : 'local';

    const merged = mergeSnapshots(CLOUD_SYNC_KEY_STRATEGIES, input.base, input.local, remoteSide, tieBreak);

    return {
        merged,
        applied: CLOUD_SYNC_DATA_KEYS.some(key => !deepEqual(merged[key], input.local[key])),
        uploaded: CLOUD_SYNC_DATA_KEYS.some(key => !deepEqual(merged[key], remoteSide[key])),
        remoteSide,
        tieBreak,
        hasBase
    };
}

/**
 * 云端那一版结构非法就中止
 * 合并前的双向校验用它，「拿云端整份覆盖本地」也用它：坏数据一旦被写下去，
 * 盖掉的是好那一端，而且下一次同步会把这份坏数据扩散到其他设备。
 */
export function assertRemoteUsable(remote: SyncSnapshot): void {
    const violation = findCloudSyncViolation(remote);
    if (violation) {
        throw new Error(`云端${violation}`);
    }
}

/** 两端数据任一份结构非法就中止同步 */
function assertBothSidesValid(local: SyncSnapshot, remote: SyncSnapshot): void {
    const localViolation = findCloudSyncViolation(local);
    if (localViolation) {
        throw new Error(`本地${localViolation}`);
    }
    assertRemoteUsable(remote);
}
