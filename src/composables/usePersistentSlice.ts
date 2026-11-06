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
 * - load() 期间本机内存被改过时，读回来的旧值不铺回内存；
 * - persist()/mutate() 可以只写部分键：值很大的键（本地壁纸 Base64）不该因为
 *   旁边一个小参数变了就被重新落盘一次。
 */

import { storageManager } from '@/services/storage.service';
import { isBootKey, isCloudSyncedKey } from '@/services/storageSchema.service';
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
     * 只有本次真的写进了参与云同步的键才盖章：搜索引擎选择这类设备本地态改了不算编辑。
     * persist() 不盖章——首次补齐默认数据、给云同步刷盘都不算用户改动，
     * 一装机就把时间戳刷成当前，新设备就会在首次同步时把云端已有数据覆盖掉。
     */
    touchKey?: string;
}

export interface PersistentSlice {
    /** 首帧同步读快照并应用（只有注册表标记为首帧键的键会读） */
    applyBoot(): void;
    /**
     * 从后端读取并应用，同时回填快照
     *
     * 读取期间本机改过内存时不铺回旧值，返回的是当前内存值；否则返回读到的原始值
     * （归一化与否由调用方判断）。
     */
    load(): Promise<Record<string, StorageValue | null>>;
    /** 把当前内存写回后端；失败时抛出，内存不动。writeKeys 省略时写全部键 */
    persist(writeKeys?: string[]): Promise<void>;
    /** 先改内存再落盘；落盘失败时把内存还原到改动前 */
    mutate(change: () => void, writeKeys?: string[]): Promise<void>;
    /** 应用外部变更，返回是否有键命中 */
    applyExternalChanges(changes: StorageChanges): boolean;
    /**
     * 应用云同步下发的值：只处理 values 里出现且属于本 slice 的键
     *
     * 落盘但不盖「本机改过」时间戳——把云端结果写回本地不是本机编辑，
     * 盖了戳下次同步就会被判成「本机也改过」，同一条改动会在两台设备之间来回推。
     * @returns 是否有键被应用
     */
    applyRemote(values: Record<string, StorageValue | null>): Promise<boolean>;
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

    /**
     * 本机内存改动序号
     *
     * load() 的异步读取和用户的改动会交错：读回来的值可能在等待期间就被改过，
     * 那时它是改动前的旧快照，铺回内存等于把用户的改动倒回去。
     * 每次本机内存变更（含其他标签页与云同步下发）都让这个序号前进。
     */
    let revision = 0;

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
        if (touched && touchKey && selected.some(sliceKey => isCloudSyncedKey(sliceKey.key))) {
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
        const revisionBeforeRead = revision;
        const stored = await storageManager.getMany(keys.map(sliceKey => sliceKey.key));

        // 回填首帧快照：老版本没有快照、快照被清掉过、
        // 或者这份数据压根没存过（用默认值），都要把当前值写进去，
        // 否则这类用户每次打开新标签页都要再闪一次（同步数据永远等不到）。
        const backfillBootMirror = () => {
            for (const sliceKey of keys) {
                if (isBootKey(sliceKey.key)) {
                    storageManager.writeSyncMirror(sliceKey.key, plainValue(sliceKey.read()));
                }
            }
        };

        if (revision !== revisionBeforeRead) {
            // 读取期间本机内存改过（用户改动 / 其他标签页 / 云同步下发）：
            // 这批值读的是改动前的存储状态，铺回去就是把改动倒回去。
            // 内存不需要回写——每次本机改动都是写穿式的，存储里已经是最新值；
            // 返回内存里的值，调用方（如 appData.init）才不会拿旧值再铺一遍。
            const effective: Record<string, StorageValue | null> = {};
            for (const sliceKey of keys) {
                effective[sliceKey.key] = plainValue(sliceKey.read());
            }
            backfillBootMirror();
            return effective;
        }

        for (const sliceKey of keys) {
            const raw = stored[sliceKey.key];
            if (raw === null || raw === undefined) {
                continue;
            }
            sliceKey.apply(raw);
        }

        backfillBootMirror();
        return stored;
    }

    async function mutate(change: () => void, writeKeys?: string[]): Promise<void> {
        const previous = keys.map(sliceKey => plainValue(sliceKey.read()));
        change();
        revision++;
        try {
            await write(selectKeys(writeKeys), true);
        } catch (error) {
            keys.forEach((sliceKey, index) => {
                sliceKey.apply(previous[index] as StorageValue);
            });
            revision++;
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
        if (applied) {
            revision++;
        }
        return applied;
    }

    async function applyRemote(values: Record<string, StorageValue | null>): Promise<boolean> {
        const selected = keys.filter(sliceKey => Object.prototype.hasOwnProperty.call(values, sliceKey.key));
        if (!selected.length) {
            return false;
        }

        const previous = selected.map(sliceKey => plainValue(sliceKey.read()));
        selected.forEach(sliceKey => {
            sliceKey.apply(values[sliceKey.key] as StorageValue | null);
        });
        revision++;
        try {
            await write(selected, false);
        } catch (error) {
            selected.forEach((sliceKey, index) => {
                sliceKey.apply(previous[index] as StorageValue);
            });
            revision++;
            throw error;
        }
        return true;
    }

    function subscribe(): () => void {
        return storageManager.subscribe(applyExternalChanges);
    }

    return { applyBoot, load, persist, mutate, applyExternalChanges, applyRemote, subscribe };
}
