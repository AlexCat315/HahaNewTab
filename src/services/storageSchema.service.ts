/**
 * 存储键注册表（L2）—— 全项目唯一的存储契约
 *
 * 「这个键存在哪、要不要进首帧快照、要不要云同步、是不是大对象、归谁写」
 * 全部在这里登记一次，其余模块只消费派生结果：
 *   - 底层区域访问在 storageBackends（L0）；
 *   - 快照 / 镜像 / 变更通知 / 用量在 storage.service（L1，统一门面）；
 *   - 首帧预加载用的常量与主题数据在构建期由 scripts/gen-boot-bundle.mjs
 *     从 src/config/storageContract.json 注入，不再在 public/theme-preload.js 里手写。
 */

import storageContract from '@/config/storageContract.json';
import { STORAGE_KEYS } from '@/types/storage';
import { isAppNavigatorData } from '@/types/app';
import type { AppNavigatorData } from '@/types/app';
import { isUserUiLib } from '@/types/ui';
import type { UserUiLib } from '@/types/ui';
import {
    isLayoutSettings,
    isThemeSettings,
    isWallpaperImageData,
    isWallpaperSettings
} from '@/types/storage';
import type { MediaCacheSettings } from '@/types/storage';
import {
    mergeFieldwiseSnapshot,
    mergeMainDataSnapshot,
    mergeScalarSnapshot,
    mergeSearchHistorySnapshot,
    mergeUserUiLibSnapshot
} from '@/utils/syncMerge.util';
import type { CloudSyncKeyStrategy } from '@/utils/syncMerge.util';

/** 存储后端：扩展本地存储 */
export type StorageBackendName = 'local';

/** 大对象：每次 setMany 都要 clone 与广播，未来可迁到 IndexedDB */
export type StorageSizeClass = 'large';

/** 键的归属 store：只有 owner 能写这个键，用于消灭「两个 store 写同一个键」 */
export type StorageOwner =
    | 'appData'
    | 'uiLib'
    | 'theme'
    | 'layout'
    | 'search'
    | 'cache'
    | 'wallpaper'
    | 'cloudSync';

/** 媒体缓存策略（配置值统一来自契约 JSON） */
export interface StorageCachePolicy {
    kind: 'icon' | 'wallpaper';
    ttlMs: number;
}

/**
 * 云同步键的处理策略
 *
 * 一个键要参与同步，光「收集」不够：云端值和其他设备的本地值都可能是
 * 旧结构 / 被截断的数据，直接合并会把坏数据推到云端；
 * 所以校验和合并规则跟键一起登记在这里，云同步服务只按表执行。
 */
export interface CloudKeyPolicy {
    /** 值能否作为该键的同步数据 */
    validate: (value: unknown) => boolean;
    /** 校验失败时的提示语（会带上键归属，便于用户知道是哪份数据坏了） */
    rejectMessage: string;
    /** 三方合并该键的值，具体规则见 syncMerge.util */
    merge: CloudSyncKeyStrategy['merge'];
}

export interface StorageKeyDefinition<T = unknown> {
    /** 实际存储键名 */
    id: string;
    /** 落在哪个后端 */
    backend: StorageBackendName;
    /**
     * 是否写进首帧快照（localStorage 的 __boot__）。
     * 只有「首帧渲染就要用到、等异步 storage.local 回来会闪一下」的设置才需要；
     * 会随使用增长的数据（搜索历史）绝不能进——每次写任一 boot 键都要整份序列化。
     */
    boot?: boolean;
    /** 参与云同步时怎么处理；登记即表示该键会被收进同步快照 */
    cloud?: CloudKeyPolicy;
    /** 媒体缓存策略；登记即表示该键由 mediaCacheService 管理 */
    cache?: StorageCachePolicy;
    /** 体积标记：写入与广播成本高的键 */
    sizeClass?: StorageSizeClass;
    /** 归属 store */
    owner?: StorageOwner;
    /** 缺省值：键从未写入过时的行为基准，供 owner 侧取初值 */
    defaultValue?: T;
}

function defineKey<T = unknown>(definition: StorageKeyDefinition<T>): StorageKeyDefinition<T> {
    return definition;
}

/** 首帧快照键名 / 结构版本 / 预加载要读的键，全部来自唯一契约 */
export const BOOT_SNAPSHOT_KEY = storageContract.boot.key;
export const BOOT_SNAPSHOT_VERSION = storageContract.boot.version;
export const PRELOAD_THEME_KEYS = storageContract.boot.preload;

/** 媒体缓存的数据库与过期策略，全部来自唯一契约 */
export const MEDIA_CACHE_CONTRACT = storageContract.mediaCache;
export const MEDIA_CACHE_TTL = {
    icon: storageContract.mediaCache.ttlMs.icon,
    wallpaper: storageContract.mediaCache.ttlMs.wallpaper
};

/** 诊断配置与固定槽键（生产关闭，槽数量有上限） */
export const DIAG_CONTRACT = storageContract.diag;
export const DIAG_STORAGE_KEYS: readonly string[] = Array.from(
    { length: storageContract.diag.slots },
    (_unused, index) => `${storageContract.diag.keyPrefix}${index}`
);

/**
 * 搜索历史的结构判据
 *
 * 条目形状由 search store 定义，这里只负责云端下发的值能不能作为它。
 * 空数组是合法的（本机清空过），非数组或条目缺字段才算非法。
 */
function isSearchHistoryList(value: unknown): boolean {
    return Array.isArray(value) && value.every(item =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { query?: unknown }).query === 'string' &&
        typeof (item as { time?: unknown }).time === 'number'
    );
}

/** 主题标识：非空字符串（从未选过则该键缺席，不算非法） */
function isThemeId(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0;
}

/** 全部已登记的存储键 */
export const STORAGE_SCHEMA = {
    mainData: defineKey<AppNavigatorData>({
        id: STORAGE_KEYS.MAIN_DATA,
        backend: 'local',
        owner: 'appData',
        sizeClass: 'large',
        cloud: {
            validate: isAppNavigatorData,
            rejectMessage: '应用数据格式无效',
            merge: mergeMainDataSnapshot
        }
    }),
    userUiLib: defineKey<UserUiLib>({
        id: STORAGE_KEYS.USER_UI_LIB,
        backend: 'local',
        owner: 'uiLib',
        sizeClass: 'large',
        cloud: {
            validate: isUserUiLib,
            rejectMessage: '图标库格式无效',
            merge: mergeUserUiLibSnapshot
        }
    }),
    /**
     * 本机最后一次用户改动的时间戳。
     * 首次同步没有共同祖先可比，同 id 冲突只能按「哪端写得更晚」定方向，靠的就是它；
     * 所以每个参与云同步的 store 都必须盖章（usePersistentSlice 的 touchKey），
     * 漏掉一个键，那次改动就会在首次同步时被云端旧值倒回去。
     * 不参与同步，也不进首帧快照。
     */
    dataUpdatedAt: defineKey({
        id: STORAGE_KEYS.DATA_UPDATED_AT,
        backend: 'local'
    }),
    selectedTheme: defineKey<string>({
        id: STORAGE_KEYS.SELECTED_THEME,
        backend: 'local',
        boot: true,
        owner: 'theme',
        cloud: {
            validate: isThemeId,
            rejectMessage: '主题选择格式无效',
            merge: mergeScalarSnapshot
        }
    }),
    themeSettings: defineKey({
        id: STORAGE_KEYS.THEME_SETTINGS,
        backend: 'local',
        boot: true,
        owner: 'theme',
        cloud: {
            validate: isThemeSettings,
            rejectMessage: '主题偏好格式无效',
            merge: mergeFieldwiseSnapshot
        }
    }),
    layoutSettings: defineKey({
        id: STORAGE_KEYS.LAYOUT_SETTINGS,
        backend: 'local',
        boot: true,
        owner: 'layout',
        // 逐字段合并 + 冲突本机优先：列数这类跟屏幕绑定的设置，
        // 本机手动设定过就一直是本机的值，另一台设备改的不覆盖过来；
        // 没设定过（出厂值沿用）的新设备则跟随云端。
        cloud: {
            validate: isLayoutSettings,
            rejectMessage: '布局设置格式无效',
            merge: mergeFieldwiseSnapshot
        }
    }),
    sidebarCollapsed: defineKey<boolean>({
        id: STORAGE_KEYS.SIDEBAR_COLLAPSED,
        backend: 'local',
        boot: true,
        owner: 'layout',
        defaultValue: false
    }),
    /**
     * 搜索引擎选择：存的是内置列表里的数组下标，不是标识。
     * 列表顺序一改，跨设备同步过去就会静默选中另一个引擎，
     * 因此它不参与云同步；要同步得先改成存引擎 id。
     */
    selectedSearchEngine: defineKey({
        id: STORAGE_KEYS.SELECTED_SEARCH_ENGINE,
        backend: 'local',
        boot: true,
        owner: 'search'
    }),
    // 搜索历史会随使用增长：不进首帧快照，否则每次写任一 boot 键都要整份序列化它。
    // 首帧也用不到（要打开搜索框才可见），挂载后异步读即可。
    searchHistory: defineKey<unknown[]>({
        id: STORAGE_KEYS.SEARCH_HISTORY,
        backend: 'local',
        owner: 'search',
        defaultValue: [],
        cloud: {
            validate: isSearchHistoryList,
            rejectMessage: '搜索历史格式无效',
            merge: mergeSearchHistorySnapshot
        }
    }),
    mediaCache: defineKey<MediaCacheSettings>({
        id: STORAGE_KEYS.MEDIA_CACHE,
        backend: 'local',
        boot: true,
        owner: 'cache',
        cache: {
            kind: 'icon',
            ttlMs: storageContract.mediaCache.ttlMs.icon
        },
        defaultValue: { enabled: true }
    }),
    wallpaper: defineKey({
        id: STORAGE_KEYS.WALLPAPER,
        backend: 'local',
        owner: 'wallpaper',
        cloud: {
            validate: isWallpaperSettings,
            rejectMessage: '壁纸设置格式无效',
            merge: mergeFieldwiseSnapshot
        }
    }),
    wallpaperImage: defineKey({
        id: STORAGE_KEYS.WALLPAPER_IMAGE,
        backend: 'local',
        owner: 'wallpaper',
        sizeClass: 'large',
        // 整体替换而不是逐字段：图片内容与文件名/尺寸是同一张照片的属性，
        // 混着两端字段拼出来的是一张「元数据对不上」的壁纸。
        // Base64 正文在上传前由资源通道换成 haha-asset:// 引用，不占主文件体积。
        cloud: {
            validate: isWallpaperImageData,
            rejectMessage: '本地壁纸图片格式无效',
            merge: mergeScalarSnapshot
        }
    }),
    cloudToken: defineKey({
        id: STORAGE_KEYS.CLOUD_TOKEN,
        backend: 'local',
        owner: 'cloudSync'
    }),
    cloudGistId: defineKey({
        id: STORAGE_KEYS.CLOUD_GIST_ID,
        backend: 'local',
        owner: 'cloudSync'
    }),
    cloudAutoSync: defineKey<boolean>({
        id: STORAGE_KEYS.CLOUD_AUTO_SYNC,
        backend: 'local',
        owner: 'cloudSync',
        defaultValue: false
    }),
    cloudLastSyncTime: defineKey<number>({
        id: STORAGE_KEYS.CLOUD_LAST_SYNC_TIME,
        backend: 'local',
        owner: 'cloudSync',
        defaultValue: 0
    }),
    cloudUserInfo: defineKey({
        id: STORAGE_KEYS.CLOUD_USER_INFO,
        backend: 'local',
        owner: 'cloudSync'
    }),
    cloudSyncBase: defineKey({
        id: STORAGE_KEYS.CLOUD_SYNC_BASE,
        backend: 'local',
        owner: 'cloudSync'
    }),
    cloudSeenRevisions: defineKey({
        id: STORAGE_KEYS.CLOUD_SYNC_SEEN_REVISIONS,
        backend: 'local',
        owner: 'cloudSync'
    }),
    updateCheckCache: defineKey({
        id: STORAGE_KEYS.UPDATE_CHECK_CACHE,
        backend: 'local'
    }),
    updateDismissedVersion: defineKey({
        id: STORAGE_KEYS.UPDATE_DISMISSED_VERSION,
        backend: 'local'
    })
} as const;

/** 注册表里的键名（symbol，与实际存储键名一一对应） */
export type StorageKeySymbol = keyof typeof STORAGE_SCHEMA;

const DEFINITION_BY_ID = new Map<string, StorageKeyDefinition<unknown>>(
    Object.values(STORAGE_SCHEMA).map(definition => [definition.id, definition])
);

/** 取某个键的定义；未登记的键返回 null（不参与快照 / 云同步 / 归属判定） */
export function getStorageKeyDefinition(id: string): StorageKeyDefinition<unknown> | null {
    return DEFINITION_BY_ID.get(id) ?? null;
}

/** 全部登记过的键名（用量统计与清理用） */
export const ALL_STORAGE_KEYS: readonly string[] = [...DEFINITION_BY_ID.keys()];

/**
 * 大对象名单直接由注册表的 sizeClass 派生，不再在契约 JSON 里另写一份键名：
 * 这是「新增大对象只改注册表一处」的落地点，也让 sizeClass 有真实消费方。
 */
export const LARGE_STORAGE_KEYS: readonly string[] = Object.values(STORAGE_SCHEMA)
    .filter(definition => definition.sizeClass === 'large')
    .map(definition => definition.id);

/**
 * 需要镜像进 localStorage 的首屏设置键（旧名沿用，语义已变成「由注册表派生的首帧快照键」）。
 * 防 FOUC 的前提：storage.local 是异步的，等它回来再渲染会先错画一帧。
 */
export const SYNC_MIRROR_KEYS: ReadonlySet<string> = new Set(
    Object.values(STORAGE_SCHEMA)
        .filter(definition => definition.boot === true)
        .map(definition => definition.id)
);

/** 登记了云同步策略的键定义 */
const CLOUD_KEY_DEFINITIONS = Object.values(STORAGE_SCHEMA).filter(
    definition => definition.cloud !== undefined
);

/**
 * 云同步需要收集的本地数据键
 *
 * 站点数据、图标库，加上个性化设置（主题、布局、壁纸、搜索历史）。
 * 不参与同步的是设备本地态：侧栏折叠、媒体缓存开关、搜索引擎选择（存的是下标）、
 * 云同步自身的凭据与快照。
 */
export const CLOUD_SYNC_DATA_KEYS: string[] = CLOUD_KEY_DEFINITIONS.map(
    definition => definition.id
);

/** 云同步逐键合并策略，交给 syncMerge 的通用快照合并 */
export const CLOUD_SYNC_KEY_STRATEGIES: CloudSyncKeyStrategy[] = CLOUD_KEY_DEFINITIONS.map(
    definition => ({ key: definition.id, merge: definition.cloud!.merge })
);

/** 某个键是否需要写进首帧快照 */
export function isBootKey(id: string): boolean {
    return SYNC_MIRROR_KEYS.has(id);
}

/** 某个键是否参与云同步（「本机改过这份数据」的盖章只看它） */
export function isCloudSyncedKey(id: string): boolean {
    return CLOUD_SYNC_DATA_KEYS.includes(id);
}

/** 某个键是不是大对象 */
export function isLargeKey(id: string): boolean {
    return Object.values(STORAGE_SCHEMA).some(
        definition => definition.id === id && definition.sizeClass === 'large'
    );
}

/**
 * 契约一致性自检：JSON 里的键名与 TS 侧常量必须同步改。
 * 构建期注入的预加载脚本读的是 JSON，运行时读的是 STORAGE_KEYS，
 * 漂移了就会让首帧读到错的键；宁可在这里直接报错，也不要静默降级。
 */
function assertContractInSync(): void {
    const { preload } = storageContract.boot;
    if (preload.selectedThemeKey !== STORAGE_KEYS.SELECTED_THEME ||
        preload.themeSettingsKey !== STORAGE_KEYS.THEME_SETTINGS) {
        throw new Error('[StorageContract] 预加载键名与 STORAGE_KEYS 不一致');
    }
}

assertContractInSync();

/**
 * 校验一份同步快照（本地收集结果 / 云端下发的 data）
 *
 * 键缺失是合法的：那一端还没有这份数据，合并时按空数据参与；
 * 只有「有值但结构不对」才拦下来，避免把坏数据合并后推上云端、覆盖掉另一端的好数据。
 *
 * @returns 第一个非法值的提示语，全部合法时返回 null
 */
export function findCloudSyncViolation(data: Record<string, unknown>): string | null {
    for (const definition of CLOUD_KEY_DEFINITIONS) {
        const value = data[definition.id];
        if (value !== undefined && value !== null && !definition.cloud!.validate(value)) {
            return definition.cloud!.rejectMessage;
        }
    }
    return null;
}

/**
 * base 快照里有没有可参照的旧数据
 *
 * 一次也没有同步成功过（或刚换平台）时 base 是空的，三方合并失去共同祖先，
 * 同 id 冲突只能按「谁的最后写入更晚」定方向，见 CloudSyncService.sync。
 */
export function hasCloudSyncBase(base: Record<string, unknown> | null | undefined): boolean {
    return CLOUD_SYNC_DATA_KEYS.some(key => base?.[key] !== undefined && base?.[key] !== null);
}
