/**
 * chrome.storage.sync 封装（跨设备同步区）
 *
 * 与 storage.service 的本地存储相互独立：
 *   - 扩展环境：走浏览器账号同步区 storage.sync，登录同一账号的其他设备可见；
 *   - 非扩展环境（网页版调试）：降级为 localStorage 加前缀模拟，仅本机可见。
 *
 * 区域探测、Promise / 回调风格适配、降级读写、变更事件订阅都由 L0
 * （storageBackends.service.ts）实现，这里只剩同步区的语义外壳：状态上报 + 错误文案。
 *
 * 注意：storage.sync 有配额限制（单条 8KB / 总计约 100KB），只适合存放加密后的短凭据。
 * 因此这里把「是否真的走了原生同步区」暴露给上层（getSyncAreaStatus），
 * 避免网页预览环境下用户以为凭据已经同步到浏览器账号，实际只写进了本机 localStorage。
 */

import {
    getStorageBackend,
    subscribeStorageArea,
    translateStorageError
} from '@/services/storageBackends.service';
import type { StorageChanges } from '@/types/storage';

/** 同步区形态：native = 浏览器账号同步区；local = localStorage 降级 */
export type SyncAreaKind = 'native' | 'local';

/** 同步区状态 */
export interface SyncAreaStatus {
    /** 是否使用浏览器原生同步区 */
    native: boolean;
    /** 形态标识，便于 UI 展示提示 */
    kind: SyncAreaKind;
}

/**
 * 每次调用重新取后端，不做模块级缓存：
 * 扩展上下文可能在页面存活期间才注入或失效，测试也依赖装好 window.chrome 后立即生效。
 */
function syncBackend() {
    return getStorageBackend('sync');
}

/** 是否使用浏览器原生同步区（否则是 localStorage 降级） */
export function isNativeSyncStorage(): boolean {
    return syncBackend().native;
}

/** 当前同步区状态（UI 用于提示「仅在扩展中生效」） */
export function getSyncAreaStatus(): SyncAreaStatus {
    const native = isNativeSyncStorage();
    return { native, kind: native ? 'native' : 'local' };
}

/** 读取单个同步项 */
export async function syncGet(key: string): Promise<unknown | null> {
    try {
        const items = await syncBackend().get(key);
        return items[key] ?? null;
    } catch (error) {
        throw translateStorageError(error, '读取浏览器同步区失败');
    }
}

/** 写入单个同步项 */
export async function syncSet(key: string, value: unknown): Promise<void> {
    try {
        await syncBackend().set({ [key]: value });
    } catch (error) {
        throw translateStorageError(
            error,
            isNativeSyncStorage() ? '写入浏览器同步区失败' : '写入本机模拟同步区失败'
        );
    }
}

/** 删除单个同步项 */
export async function syncRemove(key: string): Promise<void> {
    try {
        await syncBackend().remove(key);
    } catch (error) {
        throw translateStorageError(error, '清理浏览器同步区失败');
    }
}

/**
 * 订阅同步区变更
 *
 * 其他设备推送凭据后，本机可在不重开面板的情况下感知到（areaName === 'sync'）。
 * 非扩展环境没有原生同步区，直接返回空的取消函数。
 */
export function subscribeSyncAreaChanges(
    listener: (changes: Record<string, { newValue?: unknown }>) => void
): () => void {
    return subscribeStorageArea('sync', listener as (changes: StorageChanges) => void);
}

