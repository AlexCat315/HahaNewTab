/**
 * 存储契约单测
 * 覆盖：契约与 STORAGE_KEYS 的一致性、首帧快照瘦身、大对象标记、
 * 媒体缓存 TTL 单一来源、用量统计。
 * 构建期生成脚本的产物由 npm run build 验证（不引入 Node 类型依赖）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    BOOT_SNAPSHOT_KEY,
    BOOT_SNAPSHOT_VERSION,
    LARGE_STORAGE_KEYS,
    MEDIA_CACHE_TTL,
    PRELOAD_THEME_KEYS,
    SYNC_MIRROR_KEYS,
    isLargeKey
} from '@/services/storageSchema.service';
import { STORAGE_KEYS } from '@/types/storage';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { ICON_CACHE_TTL_MS, WALLPAPER_CACHE_TTL_MS } from '@/services/mediaCache.service';

describe('存储契约', () => {
    beforeEach(() => {
        localStorage.clear();
        browserApi.resetDetection();
    });

    it('预加载用的键名与 STORAGE_KEYS 来自同一份契约', () => {
        expect(PRELOAD_THEME_KEYS.selectedThemeKey).toBe(STORAGE_KEYS.SELECTED_THEME);
        expect(PRELOAD_THEME_KEYS.themeSettingsKey).toBe(STORAGE_KEYS.THEME_SETTINGS);
        expect(BOOT_SNAPSHOT_KEY).toBe('__boot__');
        expect(BOOT_SNAPSHOT_VERSION).toBe(1);
    });

    it('首帧快照保留视觉键，剔除会随使用增长的搜索历史', () => {
        expect(SYNC_MIRROR_KEYS.has(STORAGE_KEYS.SELECTED_THEME)).toBe(true);
        expect(SYNC_MIRROR_KEYS.has(STORAGE_KEYS.THEME_SETTINGS)).toBe(true);
        expect(SYNC_MIRROR_KEYS.has(STORAGE_KEYS.LAYOUT_SETTINGS)).toBe(true);
        expect(SYNC_MIRROR_KEYS.has(STORAGE_KEYS.SEARCH_HISTORY)).toBe(false);
    });

    it('契约里的 largeKeys 全部在注册表标了 sizeClass', () => {
        expect(LARGE_STORAGE_KEYS.length).toBeGreaterThan(0);
        for (const key of LARGE_STORAGE_KEYS) {
            expect(isLargeKey(key)).toBe(true);
        }
        expect(isLargeKey(STORAGE_KEYS.WALLPAPER_IMAGE)).toBe(true);
        expect(isLargeKey(STORAGE_KEYS.CLOUD_TOKEN)).toBe(false);
    });

    it('媒体缓存 TTL 从契约导出，不再各写一份', () => {
        expect(ICON_CACHE_TTL_MS).toBe(MEDIA_CACHE_TTL.icon);
        expect(WALLPAPER_CACHE_TTL_MS).toBe(MEDIA_CACHE_TTL.wallpaper);
        expect(MEDIA_CACHE_TTL.wallpaper).toBeGreaterThan(MEDIA_CACHE_TTL.icon);
    });

    it('用量统计随写入增长', async () => {
        const before = await storageManager.usage();
        await storageManager.set(STORAGE_KEYS.MAIN_DATA, {
            categories: [],
            apps: [{ id: 'a1', name: '样例站点', url: 'https://example.com', category: 'c1' }]
        });
        const after = await storageManager.usage();
        expect(after).toBeGreaterThan(before);
    });
});
