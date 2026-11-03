/**
 * 存储键注册表（L2）
 *
 * 全项目唯一的一份「这个键存在哪个后端、要不要进首帧快照、要不要云同步（以及校验与合并规则）、归谁写」清单。
 * 以前首帧镜像键集合、云同步键集合、预加载脚本各写一份，改一个设置要同步改四处；
 * 现在这些都从本表派生，加一个键只需要在这里登记一次。
 *
 * 这里只放元数据，不做读写：底层区域访问在 storageBackends（L0），
 * 快照 / 镜像 / 变更通知在 storage.service（L1，存储内核）。
 */

import { STORAGE_KEYS } from '@/types/storage';
import { isAppNavigatorData } from '@/types/app';
import type { AppNavigatorData } from '@/types/app';
import { isUserUiLib } from '@/types/ui';
import type { UserUiLib } from '@/types/ui';
import type { MediaCacheSettings } from '@/types/storage';
import { mergeMainDataSnapshot, mergeUserUiLibSnapshot } from '@/utils/syncMerge.util';
import type { CloudSyncKeyStrategy } from '@/utils/syncMerge.util';

/** 存储后端：local = 扩展本地存储；sync = 浏览器账号同步区 */
export type StorageBackendName = 'local' | 'sync';

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
     * 只有「首帧渲染就要用到、等异步 storage.local 回来会闪一下」的设置才需要。
     */
    boot?: boolean;
    /** 参与云同步时怎么处理；登记即表示该键会被收进同步快照 */
    cloud?: CloudKeyPolicy;
    /** 归属 store */
    owner?: StorageOwner;
    /** 缺省值：键从未写入过时的行为基准，供 owner 侧取初值 */
    defaultValue?: T;
}

function defineKey<T = unknown>(definition: StorageKeyDefinition<T>): StorageKeyDefinition<T> {
    return definition;
}

/** 首帧快照在 localStorage 中的键名；public/theme-preload.js 在 Vue 挂载前同步读它，两边必须一致 */
export const BOOT_SNAPSHOT_KEY = '__boot__';

/**
 * 首帧快照的结构版本，也是快照整体作废的唯一判据：
 * 版本对不上（键改名、值结构变了）就当没读到，退回异步读取，
 * 避免拿着旧结构画出错乱的首帧。
 */
export const BOOT_SNAPSHOT_VERSION = 1;

/** 全部已登记的存储键 */
export const STORAGE_SCHEMA = {
    mainData: defineKey<AppNavigatorData>({
        id: STORAGE_KEYS.MAIN_DATA,
        backend: 'local',
        owner: 'appData',
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
        cloud: {
            validate: isUserUiLib,
            rejectMessage: '图标库格式无效',
            merge: mergeUserUiLibSnapshot
        }
    }),
    dataUpdatedAt: defineKey({
        id: STORAGE_KEYS.DATA_UPDATED_AT,
        backend: 'local',
        owner: 'appData'
    }),
    selectedTheme: defineKey<string>({
        id: STORAGE_KEYS.SELECTED_THEME,
        backend: 'local',
        boot: true,
        owner: 'theme'
    }),
    themeSettings: defineKey({
        id: STORAGE_KEYS.THEME_SETTINGS,
        backend: 'local',
        boot: true,
        owner: 'theme'
    }),
    layoutSettings: defineKey({
        id: STORAGE_KEYS.LAYOUT_SETTINGS,
        backend: 'local',
        boot: true,
        owner: 'layout'
    }),
    sidebarCollapsed: defineKey<boolean>({
        id: STORAGE_KEYS.SIDEBAR_COLLAPSED,
        backend: 'local',
        boot: true,
        owner: 'layout',
        defaultValue: false
    }),
    selectedSearchEngine: defineKey({
        id: STORAGE_KEYS.SELECTED_SEARCH_ENGINE,
        backend: 'local',
        boot: true,
        owner: 'search'
    }),
    searchHistory: defineKey<unknown[]>({
        id: STORAGE_KEYS.SEARCH_HISTORY,
        backend: 'local',
        boot: true,
        owner: 'search',
        defaultValue: []
    }),
    mediaCache: defineKey<MediaCacheSettings>({
        id: STORAGE_KEYS.MEDIA_CACHE,
        backend: 'local',
        boot: true,
        owner: 'cache',
        defaultValue: { enabled: true }
    }),
    wallpaper: defineKey({
        id: STORAGE_KEYS.WALLPAPER,
        backend: 'local',
        owner: 'wallpaper'
    }),
    wallpaperImage: defineKey({
        id: STORAGE_KEYS.WALLPAPER_IMAGE,
        backend: 'local',
        owner: 'wallpaper'
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
    cloudProvider: defineKey({
        id: STORAGE_KEYS.CLOUD_PROVIDER,
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
    }),
    crossDeviceEnabled: defineKey<boolean>({
        id: STORAGE_KEYS.CROSS_DEVICE_ENABLED,
        backend: 'local',
        owner: 'cloudSync',
        defaultValue: false
    }),
    crossDevicePassphrase: defineKey({
        id: STORAGE_KEYS.CROSS_DEVICE_PASSPHRASE,
        backend: 'local',
        owner: 'cloudSync'
    }),
    crossDeviceRemoteAuth: defineKey({
        id: STORAGE_KEYS.CROSS_DEVICE_REMOTE_AUTH,
        backend: 'sync',
        owner: 'cloudSync'
    }),
    crossDeviceRemoteMeta: defineKey({
        id: STORAGE_KEYS.CROSS_DEVICE_REMOTE_META,
        backend: 'sync',
        owner: 'cloudSync'
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

/** 云同步需要收集的本地数据键（仅站点数据与用户图标库，个性化设置不同步） */
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
