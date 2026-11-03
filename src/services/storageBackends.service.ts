/**
 * L0 存储后端
 *
 * 只回答「怎么把一批值读写进某个存储区域」，不认识任何业务键，也不做同步镜像和变更通知
 * ——那是上层存储内核的事。
 *
 * 两条降级路径分开处理，是因为它们的历史行为不同，统一会破坏兼容：
 *   - local 区：扩展环境走 storage.local；网页预览沿用 browserApi 的 localStorage 实现
 *     （字符串按原样写入，读取时 JSON 解析失败就退回原始值）。
 *     首帧快照另存 __boot__ 一个键，不与后端数据混用同一个键名。
 *   - sync 区：扩展环境走 storage.sync；网页预览降级为带前缀的 localStorage 键，
 *     避免和正式数据混在一起。
 */

import { BrowserAPI } from '@/services/browserApi.service';
import { SYNC_AREA_LOCAL_PREFIX } from '@/types/storage';
import type { StorageChanges } from '@/types/storage';
import type { StorageItems } from '@/types/browserApi.types';

/** 原生扩展支持的存储区域 */
export type StorageAreaName = 'local' | 'sync';

/** 单个存储区域的后端接口：键值以对象形式读写，缺失的键不出现在结果里 */
export interface StorageBackend {
    /** 是否真的落在原生扩展存储区（false = 本机 localStorage 降级） */
    readonly native: boolean;
    get(keys: string | string[]): Promise<StorageItems>;
    set(items: StorageItems): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
}

/** 扩展原生 storage.onChanged 监听器 */
export type StorageAreaListener = (
    changes: StorageChanges,
    areaName: string
) => void;

type BackendMethod = 'get' | 'set' | 'remove';

interface NativeAreaLike {
    get: (...args: unknown[]) => unknown;
    set: (...args: unknown[]) => unknown;
    remove: (...args: unknown[]) => unknown;
}

interface NativeStorageNamespace {
    local?: NativeAreaLike;
    sync?: NativeAreaLike;
    onChanged?: {
        addListener: (listener: StorageAreaListener) => void;
        removeListener: (listener: StorageAreaListener) => void;
    };
}

interface WindowWithStorageApi {
    chrome?: {
        storage?: NativeStorageNamespace;
        runtime?: { lastError?: { message?: string } };
    };
    browser?: { storage?: NativeStorageNamespace };
    localStorage?: Storage;
}

function getWindow(): WindowWithStorageApi | null {
    return typeof window === 'undefined' ? null : (window as unknown as WindowWithStorageApi);
}

/** 取原生扩展的某个存储区，不存在时返回 null（Firefox 的 browser.* 优先，其 API 直接返回 Promise） */
function getNativeArea(area: StorageAreaName): NativeAreaLike | null {
    const win = getWindow();
    return win?.browser?.storage?.[area] ?? win?.chrome?.storage?.[area] ?? null;
}

/** Firefox 的 browser.* 直接返回 Promise，chrome.* 需要回调 */
function isPromiseStyle(area: StorageAreaName): boolean {
    return !!getWindow()?.browser?.storage?.[area];
}

/** chrome.* 回调风格失败时错误只挂在 runtime.lastError 上 */
function nativeLastError(): Error | null {
    const lastError = getWindow()?.chrome?.runtime?.lastError;
    return lastError ? new Error(lastError.message || '') : null;
}

function callNativeMethod<T>(
    areaApi: NativeAreaLike,
    method: BackendMethod,
    args: unknown[]
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        try {
            const fn = areaApi[method];
            if (typeof fn !== 'function') {
                reject(new Error(`存储区不支持 ${method}`));
                return;
            }
            fn.apply(areaApi, [...args, (result: T) => {
                const lastError = nativeLastError();
                if (lastError) {
                    reject(lastError);
                    return;
                }
                resolve(result);
            }]);
        } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

function buildNativeBackend(area: StorageAreaName, areaApi: NativeAreaLike): StorageBackend {
    const invoke = <T>(method: BackendMethod, args: unknown[]): Promise<T> =>
        isPromiseStyle(area)
            ? Promise.resolve(areaApi[method](...args) as Promise<T>)
            : callNativeMethod<T>(areaApi, method, args);

    return {
        native: true,
        get: async (keys) => (await invoke<StorageItems | undefined>('get', [keys])) ?? {},
        set: (items) => invoke<void>('set', [items]),
        remove: (keys) => invoke<void>('remove', [keys])
    };
}

/** localStorage 降级后端：prefix 用于区分不同存储区，值统一按 JSON 编码 */
function buildLocalStorageBackend(prefix: string): StorageBackend {
    const storageKey = (key: string): string => `${prefix}${key}`;

    const readRaw = (key: string): string | null =>
        getWindow()?.localStorage?.getItem(storageKey(key)) ?? null;

    return {
        native: false,
        get: async (keys) => {
            const result: StorageItems = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                const raw = readRaw(key);
                if (raw === null) {
                    continue;
                }
                try {
                    result[key] = JSON.parse(raw);
                } catch {
                    result[key] = raw;
                }
            }
            return result;
        },
        set: async (items) => {
            for (const [key, value] of Object.entries(items)) {
                getWindow()?.localStorage?.setItem(storageKey(key), JSON.stringify(value));
            }
        },
        remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                getWindow()?.localStorage?.removeItem(storageKey(key));
            }
        }
    };
}

/** local 区后端：直接复用 browserApi 的 storage.local 封装（含网页环境的 localStorage 降级） */
function buildLocalBackend(): StorageBackend {
    return {
        get native(): boolean {
            return BrowserAPI.isExtension;
        },
        get: (keys) => BrowserAPI.storage.local.get(keys),
        set: (items) => BrowserAPI.storage.local.set(items),
        remove: (keys) => BrowserAPI.storage.local.remove(keys)
    };
}

/**
 * 取某个存储区的后端
 *
 * 每次调用重新解析，不做模块级缓存：扩展上下文可能在页面存活期间才注入或失效，
 * 而测试也依赖「装好 window.chrome 后立刻生效」。
 */
export function getStorageBackend(area: StorageAreaName): StorageBackend {
    if (area === 'local') {
        return buildLocalBackend();
    }
    const nativeArea = getNativeArea('sync');
    return nativeArea
        ? buildNativeBackend('sync', nativeArea)
        : buildLocalStorageBackend(SYNC_AREA_LOCAL_PREFIX);
}

/**
 * 订阅某个存储区的原生变更事件
 *
 * 其他标签页 / 其他设备的写入会通过 onChanged 到达（areaName 匹配）。
 * 非扩展环境没有原生事件，返回空的取消函数。
 */
export function subscribeStorageArea(
    area: StorageAreaName,
    listener: (changes: StorageChanges) => void
): () => void {
    const win = getWindow();
    const onChanged = win?.browser?.storage?.onChanged ?? win?.chrome?.storage?.onChanged;
    if (!onChanged || !getStorageBackend(area).native) {
        return () => {};
    }

    const handler: StorageAreaListener = (changes, areaName) => {
        if (areaName === area) {
            listener(changes);
        }
    };

    onChanged.addListener(handler);
    return () => {
        try {
            onChanged.removeListener(handler);
        } catch {
            // 扩展卸载 / 上下文失效时忽略
        }
    };
}

/** 把底层存储错误翻译成用户能看懂的中文提示 */
export function translateStorageError(error: unknown, fallback: string): Error {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/QUOTA_BYTES_PER_ITEM/i.test(message)) {
        return new Error('浏览器同步区单条数据超限，无法写入同步凭据');
    }
    if (/QUOTA_BYTES|quota/i.test(message)) {
        return new Error('浏览器同步区空间已满，请清理后重试');
    }
    if (/MAX_WRITE_OPERATIONS/i.test(message)) {
        return new Error('浏览器同步写入过于频繁，请稍后再试');
    }
    return new Error(message || fallback);
}
