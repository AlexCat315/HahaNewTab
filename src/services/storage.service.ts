/**
 * 统一存储与数据管理层
 * 主页面、popup 和云同步必须共用本服务，避免缓存与持久化语义分叉。
 *
 * 底层读写复用 L0（storageBackends.service.ts）的 local 区后端；
 * 本层负责业务语义：同步镜像、深拷贝隔离、变更通知、遗留键清理。
 */

import { getStorageBackend, subscribeStorageArea } from '@/services/storageBackends.service';
import {
    BOOT_SNAPSHOT_KEY,
    BOOT_SNAPSHOT_VERSION,
    isBootKey
} from '@/services/storageSchema.service';
import type {
    StorageValue,
    StorageChanges,
    StorageChangeListener,
} from '@/types/storage';
import {
    STORAGE_KEYS,
    LEGACY_STORAGE_KEYS,
} from '@/types/storage';

/** 本地存储变更事件名 */
export const STORAGE_EVENT = 'haha-storage-change';

/** 首帧快照键集合（注册表派生，保留此处导出便于上层引用） */
export { SYNC_MIRROR_KEYS } from '@/services/storageSchema.service';

/** 常用存储键集合（从 types/storage.ts 重新导出） */
export { STORAGE_KEYS };

/**
 * 构建包含原始错误信息的错误对象
 * 由于项目 target 为 ES2020，Error cause 选项不在类型定义中，
 * 因此将原始错误信息拼入 message。
 */
function createError(message: string, cause?: unknown): Error {
    if (cause instanceof Error) {
        return new Error(`${message}: ${cause.message}`);
    }
    if (cause !== undefined && cause !== null) {
        return new Error(`${message}: ${String(cause)}`);
    }
    return new Error(message);
}

/**
 * 深度克隆辅助函数
 * 优先使用 structuredClone，不支持时回退到 JSON 序列化。
 */
function clone<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    if (typeof structuredClone === 'function') {
        return structuredClone(value) as T;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 解析本地存储中的字符串值
 * JSON 字符串会被解析为对应类型，解析失败则保留原字符串。
 */
function parseStoredValue(value: string | null): StorageValue {
    if (value === null || value === undefined) {
        return null;
    }
    try {
        return JSON.parse(value) as StorageValue;
    } catch (_) {
        return value;
    }
}

/**
 * L0 local 区后端
 * 扩展环境走 storage.local，网页预览沿用 browserApi 的 localStorage 实现。
 */
const localBackend = getStorageBackend('local');

/**
 * 读首帧快照（localStorage 的 __boot__）
 *
 * 所有「首帧渲染就要用到」的设置集中存在这一份里，预加载脚本和 getSync 都读它。
 * 结构版本对不上时整体作废返回 null，调用方退回异步读取，
 * 避免拿旧结构画出错乱的首帧。
 */
function readBootSnapshot(): Record<string, StorageValue> | null {
    try {
        const raw = localStorage.getItem(BOOT_SNAPSHOT_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as { v?: unknown; data?: unknown };
        if (parsed?.v !== BOOT_SNAPSHOT_VERSION || typeof parsed.data !== 'object' || parsed.data === null) {
            return null;
        }
        return parsed.data as Record<string, StorageValue>;
    } catch {
        return null;
    }
}

/**
 * 合并写入首帧快照
 * 隐私模式 / 配额满时 localStorage 会抛错，快照只是加速手段，失败不影响主流程。
 */
function writeBootSnapshot(entries: Record<string, StorageValue>): void {
    try {
        const data = { ...(readBootSnapshot() ?? {}), ...entries };
        localStorage.setItem(
            BOOT_SNAPSHOT_KEY,
            JSON.stringify({ v: BOOT_SNAPSHOT_VERSION, data })
        );
    } catch (error) {
        console.warn('[StorageManager] 写入首帧快照失败:', error);
    }
}

/** 从首帧快照中移除一个键 */
function removeBootSnapshotEntry(key: string): void {
    const data = readBootSnapshot();
    if (!data || !(key in data)) {
        return;
    }
    delete data[key];
    writeBootSnapshot(data);
}

/** 回滚首帧快照到写入前的原始内容 */
function restoreBootSnapshot(previousRaw: string | null): void {
    try {
        if (previousRaw === null) {
            localStorage.removeItem(BOOT_SNAPSHOT_KEY);
        } else {
            localStorage.setItem(BOOT_SNAPSHOT_KEY, previousRaw);
        }
    } catch (error) {
        console.warn('[StorageManager] 回滚首帧快照失败:', error);
    }
}

export interface IStorageManager {
    readonly isExtension: boolean;
    getSync(key: string): StorageValue;
    writeSyncMirror(key: string, value: StorageValue): void;
    get(key: string): Promise<StorageValue | null>;
    getMany(keys: string[]): Promise<Record<string, StorageValue | null>>;
    set(key: string, value: StorageValue): Promise<void>;
    setMany(items: Record<string, StorageValue>): Promise<void>;
    remove(key: string): Promise<void>;
    subscribe(listener: StorageChangeListener): () => void;
}

/**
 * 统一存储管理器
 * 自动检测扩展环境并选择 storage.local 或 localStorage 作为后端。
 * 首帧就要用到的设置（由存储键注册表标记）统一收进 localStorage 的 __boot__ 快照，避免 FOUC 闪烁。
 */
export class StorageManager implements IStorageManager {
    /**
     * 是否运行在浏览器扩展环境中
     */
    get isExtension(): boolean {
        return localBackend.native;
    }

    /**
     * 同步读取首帧设置（主要用于首帧渲染前的回退读取）
     *
     * 优先读 __boot__ 快照；快照还不存在时（刚升级上来、还没写过任何设置）
     * 兜底读一次旧版本的逐键镜像，保证升级后的第一帧也不闪。
     */
    getSync(key: string): StorageValue {
        const snapshot = readBootSnapshot();
        if (snapshot) {
            return snapshot[key] === undefined ? null : snapshot[key];
        }
        return parseStoredValue(localStorage.getItem(key));
    }

    /**
     * 只更新首帧快照，不触碰 storage.local。
     *
     * 用途：老版本没有快照，或快照被清掉后，把异步存储里读到的值回填进快照，
     * 这样下次打开新标签页时首帧就能直接用上，不必等异步读取回来再渲染。
     * 这里刻意不走 setMany——写 storage.local 会触发跨标签页的 onChanged，
     * 每次开新标签页都写一遍属于无意义噪音。
     */
    writeSyncMirror(key: string, value: StorageValue): void {
        if (!isBootKey(key)) {
            return;
        }
        writeBootSnapshot({ [key]: clone(value) });
    }

    /**
     * 异步读取单个存储项
     * 扩展环境中缺失且属于首帧键时，自动回退读快照并回填两份存储。
     */
    async get(key: string): Promise<StorageValue | null> {
        try {
            const items = await localBackend.get(key);
            let value: StorageValue = items[key] as StorageValue;

            if (
                (value === undefined || value === null) &&
                this.isExtension &&
                isBootKey(key)
            ) {
                value = this.getSync(key);
                if (value !== null) {
                    await localBackend.set({ [key]: value });
                    this.writeSyncMirror(key, value);
                }
            }
            return value === undefined ? null : clone(value);
        } catch (error) {
            throw createError(`读取存储项 ${key} 失败`, error);
        }
    }

    /**
     * 异步批量读取存储项
     */
    async getMany(keys: string[]): Promise<Record<string, StorageValue | null>> {
        const entries = await Promise.all(
            keys.map(async key => [key, await this.get(key)] as const)
        );
        return Object.fromEntries(entries);
    }

    /**
     * 异步写入单个存储项
     */
    set(key: string, value: StorageValue): Promise<void> {
        return this.setMany({ [key]: value });
    }

    /**
     * 异步批量写入存储项
     * 首帧键先合并进 __boot__ 快照，持久化失败时把快照回滚到写入前的内容。
     */
    async setMany(items: Record<string, StorageValue>): Promise<void> {
        const storedItems = clone(items);
        const bootEntries: Record<string, StorageValue> = {};
        for (const key of Object.keys(storedItems)) {
            if (isBootKey(key)) {
                bootEntries[key] = storedItems[key];
            }
        }

        const hasBootEntries = Object.keys(bootEntries).length > 0;
        const previousSnapshot = hasBootEntries ? localStorage.getItem(BOOT_SNAPSHOT_KEY) : null;
        if (hasBootEntries) {
            writeBootSnapshot(bootEntries);
        }

        try {
            await localBackend.set(storedItems);
        } catch (error) {
            if (hasBootEntries) {
                restoreBootSnapshot(previousSnapshot);
            }
            throw createError('写入浏览器存储失败，数据未保存', error);
        }

        window.dispatchEvent(
            new CustomEvent(STORAGE_EVENT, {
                detail: Object.fromEntries(
                    Object.entries(storedItems).map(([key, value]) => [
                        key,
                        { newValue: clone(value) },
                    ])
                ),
            })
        );
    }

    /**
     * 异步删除单个存储项
     */
    async remove(key: string): Promise<void> {
        try {
            await localBackend.remove(key);
            if (isBootKey(key)) {
                removeBootSnapshotEntry(key);
            }
        } catch (error) {
            throw createError(`删除存储项 ${key} 失败`, error);
        }

        window.dispatchEvent(
            new CustomEvent(STORAGE_EVENT, {
                detail: { [key]: { newValue: undefined } },
            })
        );
    }

    /**
     * 订阅存储变更
     * 同时监听本地事件、跨标签页 storage 事件（非扩展环境）以及扩展原生 onChanged 事件。
     */
    subscribe(listener: StorageChangeListener): () => void {
        const localHandler = (event: Event) => {
            const customEvent = event as CustomEvent<StorageChanges>;
            listener(customEvent.detail || {});
        };
        window.addEventListener(STORAGE_EVENT, localHandler);

        const storageHandler = (event: StorageEvent) => {
            if (!event.key) {
                return;
            }
            listener({ [event.key]: { newValue: parseStoredValue(event.newValue) } });
        };
        if (!this.isExtension) {
            window.addEventListener('storage', storageHandler);
        }

        const unsubscribeNative = subscribeStorageArea('local', listener);

        return () => {
            window.removeEventListener(STORAGE_EVENT, localHandler);
            window.removeEventListener('storage', storageHandler);
            unsubscribeNative();
        };
    }
}

/** 全局单例存储管理器 */
export const storageManager = new StorageManager();

/**
 * 清理历史遗留键
 *
 * 对应的功能已经改成只在当前会话生效，旧版本留下的值再也不会被读到，
 * 留着只是白占配额，还会让排查时误判「用户仍有这份状态」。
 * 键不存在时跳过，避免每次开新标签页都空写一次。
 */
export async function cleanupLegacyStorageKeys(): Promise<void> {
    for (const key of LEGACY_STORAGE_KEYS) {
        const value = await storageManager.get(key);
        if (value === null || value === undefined) {
            continue;
        }
        await storageManager.remove(key);
    }
}
