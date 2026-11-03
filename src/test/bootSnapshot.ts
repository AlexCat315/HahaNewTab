/**
 * 测试辅助：首帧快照（localStorage 的 __boot__）读写
 *
 * 快照的编码格式属于存储内核的内部契约，测试里不该各处手写一遍 JSON 结构。
 */

import { BOOT_SNAPSHOT_KEY, BOOT_SNAPSHOT_VERSION } from '@/services/storageSchema.service';
import type { StorageValue } from '@/types/storage';

/** 读首帧快照里某个键的值；快照缺失、版本不符或该键不存在时返回 null */
export function readBootSnapshotValue(key: string): StorageValue | null {
    const raw = localStorage.getItem(BOOT_SNAPSHOT_KEY);
    if (!raw) {
        return null;
    }
    const parsed = JSON.parse(raw) as { v?: number; data?: Record<string, StorageValue> };
    if (parsed?.v !== BOOT_SNAPSHOT_VERSION || !parsed.data) {
        return null;
    }
    return parsed.data[key] === undefined ? null : parsed.data[key];
}

/** 直接往首帧快照里写一个键（模拟内核已经写过快照的状态） */
export function writeBootSnapshotValue(key: string, value: StorageValue): void {
    const raw = localStorage.getItem(BOOT_SNAPSHOT_KEY);
    const parsed = raw ? (JSON.parse(raw) as { v?: number; data?: Record<string, StorageValue> }) : null;
    const data = parsed?.v === BOOT_SNAPSHOT_VERSION && parsed.data ? parsed.data : {};
    data[key] = value;
    localStorage.setItem(BOOT_SNAPSHOT_KEY, JSON.stringify({ v: BOOT_SNAPSHOT_VERSION, data }));
}
