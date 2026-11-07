/**
 * 存储相关类型定义与常量
 * 与原项目 js/storage.js、js/cloudSync.js、js/ThemeManager.js 保持一致
 */

import type { AppNavigatorData } from './app';
import type { UserUiLib, UiLib } from './ui';

/** 存储键名常量 */
export const STORAGE_KEYS = {
    MAIN_DATA: 'appNavigator_data',
    USER_UI_LIB: 'appNavigator_user_uiLib',
    DATA_UPDATED_AT: 'appNavigator_dataUpdatedAt',
    WALLPAPER: 'appNavigator_wallpaper',
    WALLPAPER_IMAGE: 'appNavigator_wallpaper_image',
    CLOUD_TOKEN: 'appNavigator_cloudSync_token',
    CLOUD_GIST_ID: 'appNavigator_cloudSync_gistId',
    CLOUD_AUTO_SYNC: 'appNavigator_cloudSync_autoSync',
    CLOUD_LAST_SYNC_TIME: 'appNavigator_cloudSync_lastSyncTime',
    CLOUD_USER_INFO: 'appNavigator_cloudSync_userInfo',
    CLOUD_SYNC_BASE: 'appNavigator_cloudSync_base',
    /**
     * 本机已经合并过的云端版本号（Gist 文件内容指纹，最新在前）。
     *
     * 存在的原因：写完紧接着读，Gist 有约 1 分钟会把旧版本再返回一次。
     * 旧版本对「三方合并」来说长得和「别的设备改了云端」一模一样，
     * 于是本机刚上传的设置会被这份过期内容倒灌回来。见过的版本号不再当新内容。
     */
    CLOUD_SYNC_SEEN_REVISIONS: 'appNavigator_cloudSync_seenRevisions',
    SELECTED_THEME: 'selectedTheme',
    /** 主题偏好设置（跟随系统开关 + 主题族），见 ThemeSettings */
    THEME_SETTINGS: 'appNavigator_themeSettings',
    SIDEBAR_COLLAPSED: 'sidebarCollapsed',
    SEARCH_HISTORY: 'searchHistory',
    SELECTED_SEARCH_ENGINE: 'selectedSearchEngine',
    /**
     * 历史遗留键：揭示模式已改为仅当前会话有效，不再读写该键。
     * 保留定义只为让 LEGACY_STORAGE_KEYS 能按名清理旧版本残留的数据。
     */
    SHOW_HIDDEN_APPS: 'appNavigator_showHiddenApps',
    HIDDEN_TIP_DISMISSED: 'appNavigator_hiddenTipDismissed',
    LAYOUT_SETTINGS: 'appNavigator_layoutSettings',
    /** 应用内更新检查的缓存结果（含上次检查时间，用于节流） */
    UPDATE_CHECK_CACHE: 'appNavigator_updateCheckCache',
    /** 用户已忽略的版本号，同一版本不再重复提示 */
    UPDATE_DISMISSED_VERSION: 'appNavigator_updateDismissedVersion',
    /** 媒体缓存开关（站点图标 / 网络壁纸的本地缓存） */
    MEDIA_CACHE: 'appNavigator_mediaCache'
} as const;

/**
 * 已废弃、只用于识别与清理的历史键。
 * 新版本不再读写，残留值只会白占配额并误导排查，启动时一次性删除。
 */
export const LEGACY_STORAGE_KEYS: string[] = [
    STORAGE_KEYS.SHOW_HIDDEN_APPS,
    /** 浏览器账号同步登录状态的功能已移除，清掉本机残留的开关与密码 */
    'appNavigator_crossDevice_enabled',
    'appNavigator_crossDevice_passphrase',
    /** 只支持 GitHub 后不再需要记录平台；旧值（可能是 gitee）留着只会误导排查 */
    'appNavigator_cloudSync_provider'
];

/**
 * 首帧快照键（SYNC_MIRROR_KEYS）与云同步收集键（CLOUD_SYNC_DATA_KEYS）
 * 已改由存储键注册表派生，见 services/storageSchema.service.ts。
 */

/** 存储项值类型 */
export type StorageValue = string | number | boolean | object | null | undefined;

/** 单个存储变更详情 */
export interface StorageChange<T = StorageValue> {
    oldValue?: T;
    newValue?: T;
}

/** 存储变更映射 */
export type StorageChanges = Record<string, StorageChange>;

/** 壁纸设置 */
export interface WallpaperSettings {
    url: string;
    opacity: number;
    blur: number;
    overlayOpacity: number;
    /** 是否为本地图片（Base64 存储） */
    isLocalImage?: boolean;
}

/**
 * 链接打开方式
 *
 * - new-tab：新开一个标签页，当前新标签页保留（历史行为）
 * - current-tab：用目标站点覆盖当前新标签页
 */
export type LinkOpenMode = 'new-tab' | 'current-tab';

/** 页面布局设置 */
export interface LayoutSettings {
    /** 每行卡片列数，'auto' 表示按宽度自适应 */
    columns: number | 'auto';
    /** 是否开启分页模式 */
    paginate: boolean;
    /** 分页模式每页卡片数 */
    pageSize: number;
    /** 是否在侧栏显示「全部应用」分类（false 时只按分类显示） */
    showAllCategory: boolean;
    /** 「全部应用」视图是否平铺显示（不按分类分组） */
    allViewFlat: boolean;
    /** 是否显示站点卡片图标背景（false 时图标背景透明） */
    showIconBackground: boolean;
    /** 极简约模式 */
    minimalMode?: boolean;
    /** 点击站点卡片 / 搜索时的跳转方式（缺省按新标签页处理） */
    openMode?: LinkOpenMode;
}

/** 媒体缓存设置 */
export interface MediaCacheSettings {
    /** 是否启用本地缓存（站点图标 / 网络壁纸） */
    enabled: boolean;
}

/**
 * 主题偏好设置
 *
 * - followSystem：是否跟随系统深色偏好。开启后明暗由系统决定，主题族保持不变。
 * - familyId：主题族 ID（色系）。跟随系统时保留用户选定的色系，避免重启后跳回默认族。
 */
export interface ThemeSettings {
    followSystem: boolean;
    familyId: string;
}

/** 本地壁纸图片元数据 */
export interface WallpaperImageData {
    data: string;
    name: string;
    type: string;
    size: number;
    timestamp: number;
}

/**
 * 设置类键的结构判据
 *
 * 云同步会把云端下发的同名键直接写回本地，坏结构一旦落盘就盖掉了本机的好数据，
 * 所以每个参与同步的键都要能回答「这个值能不能作为我」——和站点数据、图标库同一套路。
 * 可选字段缺失是合法的（老版本 payload 没写过它），出现但类型不对才算非法。
 */
export function isWallpaperSettings(value: unknown): value is WallpaperSettings {
    const item = value as Partial<WallpaperSettings> | null;
    if (!item || typeof item !== 'object') return false;
    return typeof item.url === 'string' &&
        typeof item.opacity === 'number' &&
        typeof item.blur === 'number' &&
        typeof item.overlayOpacity === 'number' &&
        (item.isLocalImage === undefined || typeof item.isLocalImage === 'boolean');
}

export function isWallpaperImageData(value: unknown): value is WallpaperImageData {
    const item = value as Partial<WallpaperImageData> | null;
    if (!item || typeof item !== 'object') return false;
    return typeof item.data === 'string' &&
        typeof item.name === 'string' &&
        typeof item.type === 'string' &&
        typeof item.size === 'number' &&
        typeof item.timestamp === 'number';
}

export function isThemeSettings(value: unknown): value is ThemeSettings {
    const item = value as Partial<ThemeSettings> | null;
    if (!item || typeof item !== 'object') return false;
    return typeof item.followSystem === 'boolean' &&
        typeof item.familyId === 'string';
}

export function isLayoutSettings(value: unknown): value is LayoutSettings {
    const item = value as Partial<LayoutSettings> | null;
    if (!item || typeof item !== 'object') return false;
    const columnsOk = item.columns === 'auto' || (typeof item.columns === 'number' && item.columns >= 1);
    const openModeOk = item.openMode === undefined ||
        item.openMode === 'new-tab' || item.openMode === 'current-tab';
    return columnsOk &&
        typeof item.paginate === 'boolean' &&
        typeof item.pageSize === 'number' &&
        typeof item.showAllCategory === 'boolean' &&
        typeof item.allViewFlat === 'boolean' &&
        typeof item.showIconBackground === 'boolean' &&
        (item.minimalMode === undefined || typeof item.minimalMode === 'boolean') &&
        openModeOk;
}

/** GitHub 用户信息缓存 */
export interface CloudSyncUserInfo {
    login: string;
    id: number;
    avatar: string;
}

/** 云同步设置 */
export interface CloudSyncSettings {
    token: string | null;
    gistId: string | null;
    autoSync: boolean;
    lastSyncTime: number;
    userInfo: CloudSyncUserInfo | null;
}

/** 导出/导入备份结构 */
export interface BackupData {
    data?: AppNavigatorData;
    userUiLib?: UserUiLib;
    /** 旧版本备份可能直接包含 uiLib */
    uiLib?: UiLib;
    exportTime?: string;
    version?: string;
}

/** 云同步快照（DataManager.applyStorageSnapshot 使用） */
export type StorageSnapshot = Record<string, StorageValue>;

/** 存储事件监听器 */
export type StorageChangeListener = (changes: StorageChanges) => void;

/** 存储变更来源 */
export type StorageChangeSource = 'local' | 'external' | 'cloud';
