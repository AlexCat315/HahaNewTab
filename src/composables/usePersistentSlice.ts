/**
 * usePersistentSlice - store 持久化的唯一模板
 *
 * 每个设置类 store 原本都在手写同一套流程：
 *   首帧同步读快照 → 归一化 → 改内存 → 落盘 → 失败回滚 → 订阅外部变更。
 * 这里把它收成一个 composable；键该进哪个后端、要不要进首帧快照由注册表决定，
 * store 只描述「这个键的值怎么读、怎么写进内存」。
 *
 * 语义约定（与各 store 原有行为一致）：
 * - 写入是 write-through：persist()/mutate() 的 Promise resolve 时数据已落盘；
 * - mutate() 落盘失败会把内存还原到改动前，再把错误抛给调用方；
 * - 外部变更（其他标签页、云同步）只覆盖内存，不再回写存储；
 * - persist()/mutate() 可以只写部分键：值很大的键（本地壁纸 Base64）不该因为
 *   旁边一个小参数变了就被重新落盘一次。
 */

import { storageManager } from '@/services/storage.service';
import { isBootKey } from '@/services/storageSchema.service';
import type { StorageChanges, StorageValue } from '@/types/storage';

/** slice 覆盖的单个键 */
export interface SliceKey<T extends StorageValue = StorageValue> {
    /** 存储键名 */
    key: string;
    /** 存储值 → 内存。实现方自己负责归一化：脏数据 / 缺字段应忽略而不是抛错 */
    apply: (raw: T | null) => void;
    /** 内存 → 存储值 */
    read: () => T;
}

export interface PersistentSliceOptions {
    /** 这个 slice 覆盖的键，一起读写、一起回滚 */
    keys: SliceKey[];
    /** 日志前缀 */
    label: string;
    /**
     * 「本机真的编辑过」标记键：mutate()（用户改动）落盘时顺手把它刷成当前时间。
     * persist() 不盖章——首次补齐默认数据、给云同步刷盘都不算用户改动，
     * 一装机就把时间戳刷成当前，新设备就会在首次同步时把云端已有数据覆盖掉。
     */
    touchKey?: string;
}

export interface PersistentSlice {
    /** 首帧同步读快照并应用（只有注册表标记为首帧键的键会读） */
    applyBoot(): void;
    /** 从后端读取并应用，同时回填快照；返回读到的原始值（归一化与否由调用方判断） */
    load(): Promise<Record<string, StorageValue | null>>;
    /** 把当前内存写回后端；失败时抛出，内存不动。writeKeys 省略时写全部键 */
    persist(writeKeys?: string[]): Promise<void>;
    /** 先改内存再落盘；落盘失败时把内存还原到改动前 */
    mutate(change: () => void, writeKeys?: string[]): Promise<void>;
    /** 应用外部变更，返回是否有键命中 */
    applyExternalChanges(changes: StorageChanges): boolean;
    /** 订阅外部变更，返回取消函数 */
    subscribe(): () => void;
}

/**
 * 把响应式状态转成可安全 JSON 化的普通值
 * store 里的 ref 可能是 Vue 代理，直接交给 structuredClone 会抛 DataCloneError。
 */
function plainValue<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

export function usePersistentSlice(options: PersistentSliceOptions): PersistentSlice {
    const { keys, label, touchKey } = options;

    function selectKeys(writeKeys?: string[]): SliceKey[] {
        if (!writeKeys) {
            return keys;
        }
        return keys.filter(sliceKey => writeKeys.includes(sliceKey.key));
    }

    function collectItems(selected: SliceKey[], touched: boolean): Record<string, StorageValue> {
        const items: Record<string, StorageValue> = {};
        for (const sliceKey of selected) {
            items[sliceKey.key] = plainValue(sliceKey.read());
        }
        if (touched && touchKey) {
            items[touchKey] = Date.now();
        }
        return items;
    }

    async function write(selected: SliceKey[], touched: boolean): Promise<void> {
        await storageManager.setMany(collectItems(selected, touched));
    }

    async function persist(writeKeys?: string[]): Promise<void> {
        await write(selectKeys(writeKeys), false);
    }

    function applyBoot(): void {
        for (const sliceKey of keys) {
            if (!isBootKey(sliceKey.key)) {
                continue;
            }
            try {
                const mirrored = storageManager.getSync(sliceKey.key);
                if (mirrored !== null) {
                    sliceKey.apply(mirrored as StorageValue);
                }
            } catch (error) {
                console.warn(`[${label}] 读取首帧快照 ${sliceKey.key} 失败:`, error);
            }
        }
    }

    async function load(): Promise<Record<string, StorageValue | null>> {
        const stored = await storageManager.getMany(keys.map(sliceKey => sliceKey.key));

        for (const sliceKey of keys) {
            const raw = stored[sliceKey.key];
            if (raw === null || raw === undefined) {
                continue;
            }
            sliceKey.apply(raw);
        }

        // 无论读到什么都回填首帧快照：老版本没有快照、快照被清掉过、
        // 或者这份数据压根没存过（用默认值），都要把当前值写进去，
        // 否则这类用户每次打开新标签页都要再闪一次（同步数据永远等不到）。
        for (const sliceKey of keys) {
            if (isBootKey(sliceKey.key)) {
                storageManager.writeSyncMirror(sliceKey.key, plainValue(sliceKey.read()));
            }
        }

        return stored;
    }

    async function mutate(change: () => void, writeKeys?: string[]): Promise<void> {
        const previous = keys.map(sliceKey => plainValue(sliceKey.read()));
        change();
        try {
            await write(selectKeys(writeKeys), true);
        } catch (error) {
            keys.forEach((sliceKey, index) => {
                sliceKey.apply(previous[index] as StorageValue);
            });
            throw error;
        }
    }

    function applyExternalChanges(changes: StorageChanges): boolean {
        let applied = false;
        for (const sliceKey of keys) {
            const change = changes[sliceKey.key];
            if (!change || !('newValue' in change)) {
                continue;
            }
            sliceKey.apply(
                change.newValue === undefined ? null : (change.newValue as StorageValue)
            );
            applied = true;
        }
        return applied;
    }

    function subscribe(): () => void {
        return storageManager.subscribe(applyExternalChanges);
    }

    return { applyBoot, load, persist, mutate, applyExternalChanges, subscribe };
}
