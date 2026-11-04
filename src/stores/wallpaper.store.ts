/**
 * 壁纸设置 Pinia Store
 * 管理壁纸 URL、本地 Base64 图片、透明度、模糊度、遮罩层透明度。
 *
 * 持久化全部交给 usePersistentSlice（写穿 + 失败回滚 + 外部变更订阅）：
 * 本地图片是几 MB 的 Base64，只有它自己变化时才会落盘，改透明度不重写成片图片。
 * 存储键为 STORAGE_KEYS.WALLPAPER 与 STORAGE_KEYS.WALLPAPER_IMAGE。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { usePersistentSlice } from '@/composables/usePersistentSlice';
import { STORAGE_KEYS, isWallpaperImageData } from '@/types/storage';
import type { StorageValue, WallpaperSettings, WallpaperImageData } from '@/types/storage';
import { fileToBase64 } from '@/utils/file.util';

/** 默认壁纸设置 */
export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
    url: '',
    opacity: 1,
    blur: 0,
    overlayOpacity: 0,
    isLocalImage: false
};

/** 深拷贝辅助
 * 兼容 Vue reactive proxy：structuredClone 无法克隆 Proxy，
 * 因此失败时回退到 JSON 序列化。
 */
function clone<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value) as T;
        } catch (_) {
            return JSON.parse(JSON.stringify(value)) as T;
        }
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

/** 校验并补全壁纸设置 */
function normalizeSettings(value: unknown): WallpaperSettings {
    const settings = (value ?? {}) as Partial<WallpaperSettings>;
    return {
        url: typeof settings.url === 'string' ? settings.url : DEFAULT_WALLPAPER_SETTINGS.url,
        opacity: typeof settings.opacity === 'number' ? settings.opacity : DEFAULT_WALLPAPER_SETTINGS.opacity,
        blur: typeof settings.blur === 'number' ? settings.blur : DEFAULT_WALLPAPER_SETTINGS.blur,
        overlayOpacity: typeof settings.overlayOpacity === 'number'
            ? settings.overlayOpacity
            : DEFAULT_WALLPAPER_SETTINGS.overlayOpacity,
        isLocalImage: typeof settings.isLocalImage === 'boolean'
            ? settings.isLocalImage
            : DEFAULT_WALLPAPER_SETTINGS.isLocalImage
    };
}

/** 将 Partial 应用到完整对象，忽略显式传入的 undefined */
function applyPartial<T extends object>(target: T, partial: Partial<T>): T {
    const result = { ...target };
    for (const key of Object.keys(partial) as Array<keyof T>) {
        if (partial[key] !== undefined) {
            result[key] = partial[key] as T[keyof T];
        }
    }
    return result;
}

export const useWallpaperStore = defineStore('wallpaper', () => {
    // State
    const settings = ref<WallpaperSettings>(clone(DEFAULT_WALLPAPER_SETTINGS));
    const imageData = ref<WallpaperImageData | null>(null);
    const initialized = ref(false);

    let initPromise: Promise<void> | null = null;
    let unsubscribeStorage: (() => void) | null = null;

    // Getters
    /** 当前生效的壁纸 URL：本地图片优先 */
    const effectiveUrl = computed(() => {
        if (settings.value.isLocalImage && imageData.value?.data) {
            return imageData.value.data;
        }
        return settings.value.url;
    });

    /** 是否已设置壁纸 */
    const hasWallpaper = computed(() => {
        return Boolean(settings.value.isLocalImage ? imageData.value?.data : settings.value.url);
    });

    /** 当前是否为本地图片壁纸 */
    const isLocalImage = computed(() => settings.value.isLocalImage);

    // Internal helpers

    const slice = usePersistentSlice({
        label: 'WallpaperStore',
        keys: [
            {
                key: STORAGE_KEYS.WALLPAPER,
                apply: raw => {
                    settings.value = normalizeSettings(raw);
                },
                read: () => settings.value
            },
            {
                key: STORAGE_KEYS.WALLPAPER_IMAGE,
                apply: raw => {
                    imageData.value = isWallpaperImageData(raw) ? clone(raw) : null;
                },
                read: () => imageData.value
            }
        ]
    });

    /** 只写壁纸设置（视觉参数变化时不必重写本地图片） */
    const SETTINGS_ONLY = [STORAGE_KEYS.WALLPAPER];

    // Actions

    /** 初始化：从持久化存储加载壁纸数据，并开始响应外部变更 */
    async function init(): Promise<void> {
        if (initialized.value) {
            return;
        }
        if (initPromise) {
            return initPromise;
        }

        initPromise = slice.load()
            .then(() => {
                initialized.value = true;

                if (!unsubscribeStorage) {
                    unsubscribeStorage = slice.subscribe();
                }
            })
            .catch(error => {
                initPromise = null;
                throw error;
            });

        return initPromise;
    }

    /** 设置网络壁纸 URL，同时清除本地图片标记与数据 */
    async function setUrl(url: string): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value.url = url;
            settings.value.isLocalImage = false;
            imageData.value = null;
        });
    }

    /**
     * 上传本地图片并设为壁纸
     * 文件会被读取为 Base64 Data URL 后持久化；大小不设上限，
     * 云同步侧由资源通道分片上传，不受单个 Gist 文件体积限制。
     */
    async function setLocalImage(file: File): Promise<void> {
        await init();

        const data = await fileToBase64(file);

        await slice.mutate(() => {
            imageData.value = {
                data,
                name: file.name,
                type: file.type || 'image/png',
                size: file.size,
                timestamp: Date.now()
            };
            settings.value.isLocalImage = true;
            settings.value.url = '';
        });
    }

    /** 直接设置本地图片数据（用于导入/云同步恢复等场景） */
    async function setLocalImageData(data: WallpaperImageData): Promise<void> {
        await init();
        await slice.mutate(() => {
            imageData.value = clone(data);
            settings.value.isLocalImage = true;
            settings.value.url = '';
        });
    }

    /** 设置壁纸透明度 */
    async function setOpacity(opacity: number): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value.opacity = opacity;
        }, SETTINGS_ONLY);
    }

    /** 设置壁纸模糊度 */
    async function setBlur(blur: number): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value.blur = blur;
        }, SETTINGS_ONLY);
    }

    /** 设置遮罩层透明度 */
    async function setOverlayOpacity(overlayOpacity: number): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value.overlayOpacity = overlayOpacity;
        }, SETTINGS_ONLY);
    }

    /** 批量应用壁纸设置 */
    async function applySettings(partial: Partial<WallpaperSettings>): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value = normalizeSettings(applyPartial(settings.value, partial));
        }, SETTINGS_ONLY);
    }

    /** 移除当前壁纸（清空 URL 与本地图片），保留透明度等视觉参数 */
    async function removeWallpaper(): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value.url = '';
            settings.value.isLocalImage = false;
            imageData.value = null;
        });
    }

    /** 重置为默认壁纸设置 */
    async function reset(): Promise<void> {
        await init();
        await slice.mutate(() => {
            settings.value = clone(DEFAULT_WALLPAPER_SETTINGS);
            imageData.value = null;
        });
    }

    /** 应用云同步下发的壁纸值：壁纸设置与本地图片一并落盘，无本机覆盖逻辑 */
    async function applyCloudValues(values: Record<string, StorageValue | null>): Promise<boolean> {
        return slice.applyRemote(values);
    }

    return {
        // state
        settings,
        imageData,
        initialized,
        // getters
        effectiveUrl,
        hasWallpaper,
        isLocalImage,
        // actions
        init,
        setUrl,
        setLocalImage,
        setLocalImageData,
        applyCloudValues,
        setOpacity,
        setBlur,
        setOverlayOpacity,
        applySettings,
        removeWallpaper,
        reset
    };
});
