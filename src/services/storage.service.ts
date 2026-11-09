/**
 * 统一存储与数据管理层
 * 主页面、popup 和云同步必须共用本服务，避免缓存与持久化语义分叉。
 *
 * 底层读写复用 L0（storageBackends.service.ts）的 local 区后端；
 * 本层负责业务语义：同步镜像、深拷贝隔离、变更通知、遗留键清理。
 */

import { getStorageBackend, subscribeStorageArea } from '@/services/storageBackends.service';
import {
    ALL_STORAGE_KEYS,
    BOOT_SNAPSHOT_KEY,
    BOOT_SNAPSHOT_VERSION,
    DIAG_STORAGE_KEYS,
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

/**
 * 现场诊断：内核收到的每一次变更来自哪一路
 *
 * 布局/主题/搜索的 slice 不订阅外部变更，所以「别的标签页把整块设置写回来」
 * 在 slice 层一条日志都看不到。这里挂在订阅分发处，按业务键过滤，
 * 并用「本页自己刚派发过的同一份值」识别 onChanged 自回声，剩下的就是跨页面写入。
 */
export type KernelChangeSource = 'local' | 'storage' | 'native-self' | 'native-other';

export interface KernelChangeReport {
    source: KernelChangeSource;
    keys: string[];
    signals: Record<string, unknown>;
    listenerCount: number;
}

const KERNEL_WATCHED_KEYS = new Set<string>([
    STORAGE_KEYS.LAYOUT_SETTINGS,
    STORAGE_KEYS.SELECTED_THEME,
    STORAGE_KEYS.THEME_SETTINGS,
    STORAGE_KEYS.WALLPAPER,
    STORAGE_KEYS.SELECTED_SEARCH_ENGINE,
    STORAGE_KEYS.SEARCH_HISTORY,
    STORAGE_KEYS.DATA_UPDATED_AT,
    STORAGE_KEYS.CLOUD_SYNC_BASE,
    STORAGE_KEYS.CLOUD_LAST_SYNC_TIME,
]);

/**
 * 把设置整块里排查关心的那几个字段单独摊出来
 *
 * 整块 JSON 在日志里是折叠的，只有值本身能看；跳回去的那一刻到底写进了什么，
 * 靠这个投影才不用先把整份导出贴回来。
 */
function pickSignals(key: string, value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) {
        return { [`${key}=removed`]: true };
    }
    if (key === STORAGE_KEYS.LAYOUT_SETTINGS && typeof value === 'object') {
        const settings = value as Record<string, unknown>;
        return {
            minimalMode: settings.minimalMode,
            columns: settings.columns,
            paginate: settings.paginate,
            pageSize: settings.pageSize,
        };
    }
    if (key === STORAGE_KEYS.DATA_UPDATED_AT || key === STORAGE_KEYS.CLOUD_LAST_SYNC_TIME) {
        return { [key]: value };
    }
    return { [key]: safeStringify(value).slice(0, 120) };
}

let kernelChangeListener: ((report: KernelChangeReport) => void) | null = null;
let activeListenerCount = 0;

/** 注册内核变更观察者（诊断用；不注册时零开销） */
export function setKernelChangeListener(
    listener: ((report: KernelChangeReport) => void) | null
): void {
    kernelChangeListener = listener;
}

/** 本页刚通过 CustomEvent 通知过的键值，用于诊断里标注写入来源 */
const localSignals: { key: string; json: string; at: number }[] = [];

/**
 * 本机写入的回声队列（消耗式）
 *
 * 扩展环境下一次 setMany 会走两条通知路径：本页同步派发的 CustomEvent，
 * 以及随后到达的 chrome.storage.onChanged。以前两条都无条件通知订阅者，
 * 于是每个 listener 都收到两份相同变更（slice 的 revision 加两次、诊断记两条、
 * 自动同步多排一轮）。这里在写入前登记一份期望值，onChanged 到达时精确匹配并消耗，
 * 命中就跳过 listener；跨页面写入没有对应登记，照常通知。
 *
 * 用「精确键值匹配 + 消耗一次 + 短 TTL」而不是靠时间窗猜，避免误杀跨页面同值写入。
 */
interface PendingLocalWrite {
    values: Record<string, StorageValue>;
    at: number;
}
const pendingLocalWrites: PendingLocalWrite[] = [];
const LOCAL_ECHO_TTL_MS = 5000;
const MAX_PENDING_WRITES = 32;

function rememberLocalWrite(values: Record<string, StorageValue>): PendingLocalWrite {
    const pending: PendingLocalWrite = { values, at: Date.now() };
    pendingLocalWrites.push(pending);
    if (pendingLocalWrites.length > MAX_PENDING_WRITES) {
        pendingLocalWrites.shift();
    }
    return pending;
}

function forgetLocalWrite(pending: PendingLocalWrite): void {
    const index = pendingLocalWrites.indexOf(pending);
    if (index >= 0) pendingLocalWrites.splice(index, 1);
}

function consumeLocalEcho(changes: StorageChanges): boolean {
    const now = Date.now();
    while (pendingLocalWrites.length && now - pendingLocalWrites[0].at > LOCAL_ECHO_TTL_MS) {
        pendingLocalWrites.shift();
    }
    const keys = Object.keys(changes);
    if (!keys.length) return false;
    const index = pendingLocalWrites.findIndex(pending =>
        Object.keys(pending.values).length === keys.length &&
        keys.every(key =>
            key in pending.values &&
            safeStringify(changes[key].newValue) === safeStringify(pending.values[key])
        )
    );
    if (index < 0) return false;
    pendingLocalWrites.splice(index, 1);
    return true;
}

function watchEntries(changes: StorageChanges): { key: string; json: string }[] {
    const hits: { key: string; json: string }[] = [];
    for (const key of KERNEL_WATCHED_KEYS) {
        const change = changes[key];
        if (!change || !('newValue' in change)) {
            continue;
        }
        hits.push({ key, json: safeStringify(change.newValue) });
    }
    return hits;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? 'undefined';
    } catch {
        return '<unserializable>';
    }
}

function isSelfEcho(key: string, json: string): boolean {
    const now = Date.now();
    for (let i = localSignals.length - 1; i >= 0; i--) {
        if (now - localSignals[i].at > 2000) {
            localSignals.splice(0, i + 1);
            break;
        }
        if (localSignals[i].key === key && localSignals[i].json === json) {
            return true;
        }
    }
    return false;
}

function reportKernelChange(
    source: KernelChangeSource,
    changes: StorageChanges,
    hits: { key: string; json: string }[]
): void {
    if (!kernelChangeListener || hits.length === 0) {
        return;
    }
    const signals: Record<string, unknown> = {};
    for (const hit of hits) {
        Object.assign(signals, pickSignals(hit.key, changes[hit.key]?.newValue));
    }
    kernelChangeListener({
        source,
        keys: hits.map((hit) => hit.key),
        signals,
        listenerCount: activeListenerCount,
    });
}

/** 首帧快照键集合（注册表派生，保留此处导出便于上层引用） */
export { SYNC_MIRROR_KEYS } from '@/services/storageSchema.service';

/** 常用存储键集合（从 types/storage.ts 重新导出） */
export { STORAGE_KEYS };

/**
 * 构建包含原始错误信息的错误对象
 * 由于项目 target 为 ES2020，Error cause 选项不在类型定义中，
 * 因此将原始错误信息拼入 message。
 */
/** 配额错误在不同浏览器里名字不一样，统一在这里认 */
function isQuotaError(cause: unknown): boolean {
    if (cause instanceof Error) {
        return cause.name === 'QuotaExceededError' ||
            cause.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            /quota|storage.*full|exceed/i.test(cause.message);
    }
    if (cause === undefined || cause === null) return false;
    return /quota|storage.*full|exceed/i.test(String(cause));
}

/**
 * 统一错误分类：配额满要给用户能照做的提示，其他错误保留原始信息便于排查。
 * 由门面统一构造，调用方（store / 面板）不再各自猜错误类型。
 */
function createError(message: string, cause?: unknown): Error {
    const detail = cause instanceof Error
        ? cause.message
        : (cause === undefined || cause === null ? '' : String(cause));
    if (isQuotaError(cause)) {
        return new Error(`${message}：本地存储空间不足，请删除本地壁纸或清理缓存后重试${detail ? `（${detail}）` : ''}`);
    }
    return detail ? new Error(`${message}: ${detail}`) : new Error(message);
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
const localBackend = getStorageBackend();

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
    /** 估算主存储区占用（字节），用于界面展示与超量提示 */
    usage(): Promise<number>;
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

        // 登记在发起写入之前：onChanged 可能先于 set 的 Promise 回来。
        // storedItems 已是本门面隔离出的副本，这里直接存引用，不再为去重多拷一份大对象。
        const pending = rememberLocalWrite(storedItems);
        try {
            await localBackend.set(storedItems);
        } catch (error) {
            forgetLocalWrite(pending);
            if (hasBootEntries) {
                restoreBootSnapshot(previousSnapshot);
            }
            throw createError('写入浏览器存储失败，数据未保存', error);
        }

        // 直接复用已隔离的 storedItems：以前这里对每个值再 clone 一次，
        // 大壁纸 / 图标库会因为一次写入被完整复制两遍。
        window.dispatchEvent(
            new CustomEvent(STORAGE_EVENT, {
                detail: Object.fromEntries(
                    Object.entries(storedItems).map(([key, value]) => [key, { newValue: value }])
                ),
            })
        );
    }

    /**
     * 异步删除单个存储项
     */
    async remove(key: string): Promise<void> {
        const pending = rememberLocalWrite({ [key]: undefined });
        try {
            await localBackend.remove(key);
            if (isBootKey(key)) {
                removeBootSnapshotEntry(key);
            }
        } catch (error) {
            forgetLocalWrite(pending);
            throw createError(`删除存储项 ${key} 失败`, error);
        }

        window.dispatchEvent(
            new CustomEvent(STORAGE_EVENT, {
                detail: { [key]: { newValue: undefined } },
            })
        );
    }

    /**
     * 估算主存储区占用：只统计注册表登记的键，按 JSON 序列化后的 UTF-8 长度累加。
     * 这是给界面看的量级与趋势，不等同于浏览器配额计数（后者还含键名与序列化开销）。
     */
    async usage(): Promise<number> {
        const values = await this.getMany([...ALL_STORAGE_KEYS, ...DIAG_STORAGE_KEYS]);
        let bytes = 0;
        for (const [key, value] of Object.entries(values)) {
            if (value === null || value === undefined) continue;
            try {
                bytes += new TextEncoder().encode(key + JSON.stringify(value)).length;
            } catch {
                // 单个值不可序列化时跳过，不让统计拖垮整次读取
            }
        }
        return bytes;
    }

    /**
     * 订阅存储变更
     * 同时监听本地事件、跨标签页 storage 事件（非扩展环境）以及扩展原生 onChanged 事件。
     */
    subscribe(listener: StorageChangeListener): () => void {
        activeListenerCount++;
        const localHandler = (event: Event) => {
            const customEvent = event as CustomEvent<StorageChanges>;
            const changes = customEvent.detail || {};
            const hits = watchEntries(changes);
            for (const hit of hits) {
                localSignals.push({ ...hit, at: Date.now() });
            }
            if (localSignals.length > 64) {
                localSignals.splice(0, localSignals.length - 64);
            }
            reportKernelChange('local', changes, hits);
            listener(changes);
        };
        window.addEventListener(STORAGE_EVENT, localHandler);

        const storageHandler = (event: StorageEvent) => {
            if (!event.key) {
                return;
            }
            const changes: StorageChanges = {
                [event.key]: { newValue: parseStoredValue(event.newValue) },
            };
            reportKernelChange('storage', changes, watchEntries(changes));
            listener(changes);
        };
        if (!this.isExtension) {
            window.addEventListener('storage', storageHandler);
        }

        const unsubscribeNative = subscribeStorageArea((changes) => {
            const isEcho = consumeLocalEcho(changes);
            const hits = watchEntries(changes);
            const foreign = hits.filter((hit) => !isSelfEcho(hit.key, hit.json));
            reportKernelChange(
                isEcho ? 'native-self' : (foreign.length === hits.length ? 'native-other' : 'native-self'),
                changes,
                foreign.length === 0 ? hits : foreign
            );
            // 本机写入已经由上面的 CustomEvent 通知过一次；原生 onChanged 是它的回声。
            // 顺带解决「云同步写回本地后，异步 onChanged 越过 isApplyingRemoteData 又排一轮同步」。
            if (isEcho) return;
            listener(changes);
        });

        return () => {
            activeListenerCount--;
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
