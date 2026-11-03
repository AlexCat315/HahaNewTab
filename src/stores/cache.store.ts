/**
 * cache.store
 * 媒体缓存（站点图标 / 网络壁纸）的开关与用量统计。
 *
 * 开关本身持久化在 STORAGE_KEYS.MEDIA_CACHE，并由注册表标记为首帧键（落在 __boot__ 快照）：
 * 图标组件在首帧就要决定「读缓存还是走网络」，等异步存储回来再判断会让
 * 「已关闭」状态失效一次，所以这里同步读快照拿初值。
 *
 * 真正的缓存数据在 IndexedDB（mediaCacheService），这里只负责开关与展示。
 */

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { usePersistentSlice } from '@/composables/usePersistentSlice';
import { mediaCacheService, readMediaCacheEnabled, type MediaCacheStats } from '@/services/mediaCache.service';
import { STORAGE_KEYS, type MediaCacheSettings } from '@/types/storage';

/** 空统计（IndexedDB 不可用时也返回这个） */
function emptyStats(): MediaCacheStats {
    return { count: 0, bytes: 0, byKind: { icon: 0, wallpaper: 0 } };
}

export const useCacheStore = defineStore('cache', () => {
    const enabled = ref<boolean>(readMediaCacheEnabled());
    const initialized = ref(false);
    const stats = ref<MediaCacheStats>(emptyStats());
    const loading = ref(false);

    const slice = usePersistentSlice({
        label: 'CacheStore',
        keys: [
            {
                key: STORAGE_KEYS.MEDIA_CACHE,
                apply: raw => {
                    if (!raw || typeof raw !== 'object') return;
                    const saved = (raw as Partial<MediaCacheSettings>).enabled;
                    if (typeof saved === 'boolean') {
                        enabled.value = saved;
                    }
                },
                read: (): MediaCacheSettings => ({ enabled: enabled.value })
            }
        ]
    });

    /** 首帧就同步生效，避免开关状态晚一拍 */
    mediaCacheService.setEnabled(enabled.value);

    /** 加载缓存设置（幂等） */
    async function init(): Promise<void> {
        if (initialized.value) return;
        try {
            await slice.load();
            mediaCacheService.setEnabled(enabled.value);
            initialized.value = true;
        } catch (error) {
            console.error('[CacheStore] 加载缓存设置失败:', error);
        }
    }

    /** 切换缓存开关（不清除已有缓存，重新打开即可复用） */
    async function setEnabled(value: boolean): Promise<void> {
        await slice.mutate(() => {
            enabled.value = value;
        });
        mediaCacheService.setEnabled(value);
    }

    /** 刷新用量统计 */
    async function refreshStats(): Promise<void> {
        stats.value = await mediaCacheService.stats();
    }

    /** 清空全部缓存并刷新统计 */
    async function clearCache(): Promise<void> {
        loading.value = true;
        try {
            await mediaCacheService.clear();
            await refreshStats();
        } finally {
            loading.value = false;
        }
    }

    /** 缓存是否可用（IndexedDB 被禁用时返回 false，界面据此提示） */
    function isAvailable(): boolean {
        return mediaCacheService.isAvailable();
    }

    return {
        enabled,
        initialized,
        stats,
        loading,
        init,
        setEnabled,
        refreshStats,
        clearCache,
        isAvailable,
    };
});
