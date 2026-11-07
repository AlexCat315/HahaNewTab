/**
 * L0 存储后端
 *
 * 只回答「怎么把一批值读写进 storage.local」，不认识任何业务键，也不做变更通知
 * ——那是上层存储内核的事。
 *
 * 扩展环境走 storage.local；网页预览沿用 browserApi 的 localStorage 实现
 * （字符串按原样写入，读取时 JSON 解析失败就退回原始值）。
 * 首帧快照另存 __boot__ 一个键，不与后端数据混用同一个键名。
 */

import { BrowserAPI } from '@/services/browserApi.service';
import type { StorageChanges } from '@/types/storage';
import type { StorageItems } from '@/types/browserApi.types';

/** 扩展原生 storage.onChanged 监听器 */
export type StorageAreaListener = (
    changes: StorageChanges,
    areaName: string
) => void;

interface NativeStorageNamespace {
    onChanged?: {
        addListener: (listener: StorageAreaListener) => void;
        removeListener: (listener: StorageAreaListener) => void;
    };
}

interface WindowWithStorageApi {
    browser?: { storage?: NativeStorageNamespace };
    chrome?: { storage?: NativeStorageNamespace };
}

function getWindow(): WindowWithStorageApi | null {
    return typeof window === 'undefined' ? null : (window as unknown as WindowWithStorageApi);
}

/**
 * local 区后端：直接复用 browserApi 的 storage.local 封装（含网页环境的 localStorage 降级）
 */
function buildLocalBackend() {
    return {
        get native(): boolean {
            return BrowserAPI.isExtension;
        },
        get: (keys: string | string[]) => BrowserAPI.storage.local.get(keys),
        set: (items: StorageItems) => BrowserAPI.storage.local.set(items),
        remove: (keys: string | string[]) => BrowserAPI.storage.local.remove(keys)
    };
}

/** 取 local 区后端。每次调用重新构建，不缓存：扩展上下文可能在页面存活期间才注入或失效 */
export function getStorageBackend() {
    return buildLocalBackend();
}

/**
 * 订阅 storage.onChanged 原生变更事件
 *
 * 其他标签页的写入会通过 onChanged 到达。非扩展环境没有原生事件，返回空的取消函数。
 */
export function subscribeStorageArea(
    listener: (changes: StorageChanges) => void
): () => void {
    const win = getWindow();
    const onChanged = win?.browser?.storage?.onChanged ?? win?.chrome?.storage?.onChanged;
    if (!onChanged || !BrowserAPI.isExtension) {
        return () => {};
    }

    const handler: StorageAreaListener = (changes, areaName) => {
        if (areaName === 'local') {
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
