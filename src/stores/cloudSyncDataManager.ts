/**
 * 云同步数据管理器
 *
 * CloudSyncService 只认 ICloudSyncDataManager 这一个接口，但它下发的快照早就不止站点数据：
 * 主题、布局、壁纸、搜索历史各有各的 owner store，各自持有内存副本和写盘通道。
 * 这里按注册表登记的归属把键分发下去，各 store 用 applyCloudValues 落盘，
 * 于是「加一个同步键」= 在注册表登记 + owner store 提供 applyCloudValues，服务层不用改。
 */

import { getStorageKeyDefinition } from '@/services/storageSchema.service';
import type { StorageOwner } from '@/services/storageSchema.service';
import type { ICloudSyncDataManager } from '@/types/cloudSync.types';
import type { StorageValue } from '@/types/storage';
import { useAppDataStore } from '@/stores/appData.store';
import { useUiLibStore } from '@/stores/uiLib.store';
import { useThemeStore } from '@/stores/theme.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useSearchStore } from '@/stores/search.store';
import { useWallpaperStore } from '@/stores/wallpaper.store';

type ValuesByOwner = Map<StorageOwner, Record<string, StorageValue | null>>;

/** 按注册表把快照拆成「每个 owner store 一份值」；未登记的键直接丢弃 */
function groupByOwner(snapshot: Record<string, unknown>): ValuesByOwner {
    const grouped: ValuesByOwner = new Map();
    for (const [key, value] of Object.entries(snapshot)) {
        const definition = getStorageKeyDefinition(key);
        if (!definition?.owner) {
            continue;
        }
        const bucket = grouped.get(definition.owner);
        if (bucket) {
            bucket[key] = value as StorageValue | null;
        } else {
            grouped.set(definition.owner, { [key]: value as StorageValue | null });
        }
    }
    return grouped;
}

/**
 * 创建云同步数据管理器
 *
 * 必须在 Pinia 已激活时调用（store 内部、组件 setup 里），与 useAppDataStore 同样的约束。
 */
export function createCloudSyncDataManager(): ICloudSyncDataManager {
    const appData = useAppDataStore();
    const uiLib = useUiLibStore();
    const theme = useThemeStore();
    const layout = useLayoutStore();
    const search = useSearchStore();
    const wallpaper = useWallpaperStore();

    /** 各 owner 的写入入口：谁持有这份数据的内存副本，就由谁落盘 */
    const appliers: Partial<Record<StorageOwner, (values: Record<string, StorageValue | null>) => Promise<boolean>>> = {
        appData: values => appData.applyStorageSnapshot(values),
        uiLib: values => uiLib.applyCloudValues(values),
        theme: values => theme.applyCloudValues(values),
        layout: values => layout.applyCloudValues(values),
        search: values => search.applyCloudValues(values),
        wallpaper: values => wallpaper.applyCloudValues(values)
    };

    return {
        async syncNow(): Promise<void> {
            // 其余 store 都是写穿式（改内存即落盘），只有站点数据带内存缓冲需要刷一遍
            await appData.syncNow();
        },

        async applyStorageSnapshot(snapshot: Record<string, unknown>): Promise<boolean> {
            let applied = false;
            for (const [owner, values] of groupByOwner(snapshot)) {
                const applier = appliers[owner];
                if (!applier) {
                    continue;
                }
                applied = (await applier(values)) || applied;
            }
            return applied;
        }
    };
}
