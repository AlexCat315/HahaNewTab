/**
 * 云同步三方合并工具
 * 以「上次同步成功的快照」为 base，比对 base / local / remote 三方，
 * 按 id 增量合并站点数据与用户图标库，冲突时本地优先。
 *
 * 在按 id 合并之上，额外处理三类跨设备场景：
 *   - 站点：按 URL 判重（`https://a.com` 与 `https://a.com/` 视为同一站点），本地优先保留
 *   - 分类：按名称判重，被丢弃的远端分类会把引用它的站点改指到本地同名分类
 *   - 拖动排序：顺序单独判一次归属，否则「只调换先后、不改内容」的改动在按 id 的合并里完全隐形
 * 只处理「远端 vs 本地」的重复，本地自身已有的重复保持原样，避免擅自改动用户数据。
 */

import { isAppNavigatorData } from '@/types/app';
import { isUserUiLib } from '@/types/ui';
import type { AppNavigatorData, AppItem, Category } from '@/types/app';
import type { UiCategory, UserUiLib } from '@/types/ui';
import { getUrlKey } from '@/utils/url.util';
import { normalizeNameKey } from '@/utils/name.util';

/** 同步快照数据（键为存储键名） */
export type SyncSnapshot = Record<string, unknown>;

/**
 * 同 id 冲突时的胜方
 *
 * 仅在 base 缺失（首次同步）时用得上：没有共同祖先就无法判断哪一端改过，
 * 只能按「谁最后一次写入更晚」定方向。常规三方合并不看这个，冲突一律本地优先。
 */
export type MergeTieBreak = 'local' | 'remote';

/**
 * 稳定序列化：对象键排序后 JSON.stringify，用于深比较（避免键序差异误判）
 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value !== null && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            sorted[key] = sortKeys(source[key]);
        }
        return sorted;
    }
    return value;
}

/** 深比较两个值是否相等（忽略对象键序） */
export function deepEqual(a: unknown, b: unknown): boolean {
    return stableStringify(a) === stableStringify(b);
}

function toMap<T extends { id: string }>(items: T[] | null | undefined): Map<string, T> {
    const map = new Map<string, T>();
    for (const item of items ?? []) {
        map.set(item.id, item);
    }
    return map;
}

/**
 * 以 id 为键的三方合并
 *
 * 规则（冲突一律本地优先）：
 * - 仅一端修改 → 采用修改端
 * - 两端都修改：内容相同任取其一，不同取本地
 * - 一端删除、另一端未改 → 删除
 * - 一端删除、另一端修改 → 本地优先（本地删则删，本地改则保留本地版本）
 * - 仅一端新增 → 采用新增端；两端同 id 新增取本地
 *
 * 顺序：保留本地数组顺序，远端新增项追加到末尾。
 * 这里只看 id，「谁重新排过序」由 mergeOrderedList 另行判定。
 *
 * `tieBreak` 只在 base 里查不到该 id 时生效：此时无法区分「本地新增」和
 * 「首次同步、两端各自都有的同一实体」，同 id 且内容不同的那部分交给 tieBreak 定夺，
 * 其余条目仍然两端并存（并集），不会因为选了一端就丢掉另一端的独有数据。
 */
export function mergeById<T extends { id: string }>(
    base: T[] | null | undefined,
    local: T[] | null | undefined,
    remote: T[] | null | undefined,
    tieBreak: MergeTieBreak = 'local'
): T[] {
    const baseMap = toMap(base);
    const remoteMap = toMap(remote);
    const result: T[] = [];
    const handled = new Set<string>();

    for (const item of local ?? []) {
        const id = item.id;
        handled.add(id);
        const baseItem = baseMap.get(id);
        const remoteItem = remoteMap.get(id);

        if (!baseItem) {
            // 本地新增，或两端同 id 新增/首次同步无从判断改动方
            result.push(
                tieBreak === 'remote' && remoteItem && !deepEqual(remoteItem, item)
                    ? remoteItem
                    : item
            );
            continue;
        }

        const localChanged = !deepEqual(baseItem, item);
        if (!remoteItem) {
            // 远端删除：本地未改则删除，本地已改则本地优先保留
            if (localChanged) {
                result.push(item);
            }
            continue;
        }

        const remoteChanged = !deepEqual(baseItem, remoteItem);
        if (!localChanged && remoteChanged) {
            result.push(remoteItem);
        } else {
            // 仅本地改 / 都没改 / 双改冲突（本地优先）
            result.push(item);
        }
    }

    for (const item of remote ?? []) {
        if (handled.has(item.id)) continue;
        if (!baseMap.has(item.id)) {
            // 远端新增
            result.push(item);
        }
        // 在 base 中但本地没有 → 本地删除，本地优先（删除生效）
    }

    return result;
}

/** 顺序指纹：只看 id 序列，不看条目内容——拖动排序不会改动任何一项，按 id 的合并看不出谁动过 */
function orderKey(items: readonly { id: string }[]): string {
    return items.map(item => item.id).join('\0');
}

/** 两端是否为同一批条目（id 集合相同），用于把「重排」与「增删导致的顺序变化」区分开 */
function isSameIdSet(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const ids = new Set(a.map(item => item.id));
    return b.every(item => ids.has(item.id));
}

/**
 * 这一份列表要不要改用远端的顺序
 *
 * 排序是纯顺序变化，每一项的内容与 base 完全一致，于是三方合并把两端都判成「没改」，
 * 原样输出本机顺序；而快照级的差异判定对数组顺序敏感，结果是本机把旧顺序当新数据推回云端，
 * 把另一台设备刚拖好的顺序覆盖掉——两台设备就此永久分叉。
 * 所以顺序单独判一次：远端顺序与 base 不同、本机顺序与 base 相同 → 跟随远端；
 * 本机也动过（含两端都动过）→ 仍本机优先，与内容冲突的方向一致。
 * 没有 base（首次同步 / 刚换平台）时无从比较，交给 tieBreak 定方向。
 *
 * 只在「两端就是同一批条目、只是先后不同」时生效：一旦 id 集合有出入（新增或删除），
 * 顺序只是合并的副产物，谈不上谁重排过，保持原有的「本机顺序 + 远端新增追加末尾」。
 */
function shouldFollowRemoteOrder(
    base: readonly { id: string }[] | null | undefined,
    local: readonly { id: string }[] | null | undefined,
    remote: readonly { id: string }[] | null | undefined,
    tieBreak: MergeTieBreak
): boolean {
    const current = local ?? [];
    const incoming = remote ?? [];
    if (!incoming.length || orderKey(current) === orderKey(incoming)) {
        return false;
    }
    if (!isSameIdSet(current, incoming)) {
        return false;
    }
    const ancestor = base ?? [];
    if (!ancestor.length) {
        return tieBreak === 'remote';
    }
    return orderKey(incoming) !== orderKey(ancestor) && orderKey(current) === orderKey(ancestor);
}

/** 按给定 id 顺序重排；顺序里没出现的条目（本次合并新出现的）保持原有相对顺序排在后面 */
function followOrder<T extends { id: string }>(ids: readonly string[], items: T[]): T[] {
    const rest = new Map(items.map(item => [item.id, item] as const));
    const ordered: T[] = [];
    for (const id of ids) {
        const hit = rest.get(id);
        if (hit) {
            ordered.push(hit);
            rest.delete(id);
        }
    }
    return ordered.concat([...rest.values()]);
}

/**
 * 先按 id 做三方合并，再决定沿用哪一端的顺序
 *
 * 同步范围内的每个列表（站点、分类、图标库分类、图标项）都走这里：
 * 它们的顺序都是数组顺序而非独立字段，因此都需要这层单独判定。
 */
function mergeOrderedList<T extends { id: string }>(
    base: T[] | null | undefined,
    local: T[] | null | undefined,
    remote: T[] | null | undefined,
    tieBreak: MergeTieBreak = 'local'
): T[] {
    const merged = mergeById(base, local, remote, tieBreak);
    return shouldFollowRemoteOrder(base, local, remote, tieBreak)
        ? followOrder((remote ?? []).map(item => item.id), merged)
        : merged;
}

/**
 * 合并站点列表
 *
 * 先按 id 做三方合并（含顺序判定），再去掉「远端与本地指向同一 URL」的重复项：
 * - 本地条目全部保留（本地自身已有的重复属于用户当前数据，不做删减）
 * - 远端条目若与本地（或先前保留下来的远端条目）URL 相同，则丢弃，本地版本胜出
 */
export function mergeAppList(
    base: AppItem[] | null | undefined,
    local: AppItem[] | null | undefined,
    remote: AppItem[] | null | undefined,
    tieBreak: MergeTieBreak = 'local'
): AppItem[] {
    const merged = mergeOrderedList<AppItem>(base, local, remote, tieBreak);
    const localIds = new Set((local ?? []).map((app) => app.id));
    const seenKeys = new Set<string>();

    for (const app of local ?? []) {
        const key = getUrlKey(app.url);
        if (key) seenKeys.add(key);
    }

    const result: AppItem[] = [];
    for (const app of merged) {
        const key = getUrlKey(app.url);

        // 无有效 URL 或属于本地条目：一律保留
        if (!key || localIds.has(app.id)) {
            result.push(app);
            continue;
        }

        if (seenKeys.has(key)) {
            continue;
        }
        seenKeys.add(key);
        result.push(app);
    }

    return result;
}

/**
 * 合并分类列表
 *
 * 按 id 合并（含顺序判定）后，把「与本地分类同名」的远端分类丢掉，并返回
 * `远端分类 id → 本地分类 id` 的映射，供站点改指使用。
 */
function mergeCategoryList(
    base: Category[] | null | undefined,
    local: Category[] | null | undefined,
    remote: Category[] | null | undefined,
    tieBreak: MergeTieBreak = 'local'
): { categories: Category[]; remap: Map<string, string> } {
    const merged = mergeOrderedList<Category>(base, local, remote, tieBreak);
    const localIds = new Set((local ?? []).map((category) => category.id));
    const idByName = new Map<string, string>();

    for (const category of local ?? []) {
        const key = normalizeNameKey(category.name);
        if (key && !idByName.has(key)) {
            idByName.set(key, category.id);
        }
    }

    const categories: Category[] = [];
    const remap = new Map<string, string>();

    for (const category of merged) {
        if (localIds.has(category.id)) {
            categories.push(category);
            continue;
        }

        const key = normalizeNameKey(category.name);
        if (key && idByName.has(key)) {
            // 远端同名分类 → 合并进本地分类
            remap.set(category.id, idByName.get(key)!);
            continue;
        }

        if (key) idByName.set(key, category.id);
        categories.push(category);
    }

    return { categories, remap };
}

/** 合并站点主数据（分类 + 站点） */
export function mergeAppNavigatorData(
    base: AppNavigatorData | null | undefined,
    local: AppNavigatorData | null | undefined,
    remote: AppNavigatorData | null | undefined,
    tieBreak: MergeTieBreak = 'local'
): AppNavigatorData {
    const { categories, remap } = mergeCategoryList(
        base?.categories,
        local?.categories,
        remote?.categories,
        tieBreak
    );
    const apps = mergeAppList(base?.apps, local?.apps, remote?.apps, tieBreak);

    if (remap.size === 0) {
        return { categories, apps };
    }

    // 远端分类被合并到本地同名分类后，引用它的站点要改指过去，否则会变成「无分类」
    return {
        categories,
        apps: apps.map((app) =>
            remap.has(app.category) ? { ...app, category: remap.get(app.category)! } : app
        )
    };
}

/** 合并用户图标库（分类 + 图标项，两者顺序同样由数组位置决定） */
export function mergeUserUiLib(
    base: UserUiLib | null | undefined,
    local: UserUiLib | null | undefined,
    remote: UserUiLib | null | undefined,
    tieBreak: MergeTieBreak = 'local'
): UserUiLib {
    return {
        categories: mergeOrderedList<UiCategory>(base?.categories, local?.categories, remote?.categories, tieBreak),
        items: mergeOrderedList(base?.items, local?.items, remote?.items, tieBreak)
    };
}

/** 快照里的值可能来自云端或旧版本，未经校验，合并前先按类型收窄 */
function asMainData(value: unknown): AppNavigatorData | null {
    return isAppNavigatorData(value) ? value : null;
}

function asUserUiLib(value: unknown): UserUiLib | null {
    return isUserUiLib(value) ? value : null;
}

/**
 * 主数据键的快照级合并入口
 * 供存储键注册表登记：注册表只说「这个键怎么合」，具体规则仍然在这里。
 */
export function mergeMainDataSnapshot(
    base: unknown,
    local: unknown,
    remote: unknown,
    tieBreak: MergeTieBreak = 'local'
): AppNavigatorData {
    return mergeAppNavigatorData(asMainData(base), asMainData(local), asMainData(remote), tieBreak);
}

/** 用户图标库键的快照级合并入口，同 mergeMainDataSnapshot */
export function mergeUserUiLibSnapshot(
    base: unknown,
    local: unknown,
    remote: unknown,
    tieBreak: MergeTieBreak = 'local'
): UserUiLib {
    return mergeUserUiLib(asUserUiLib(base), asUserUiLib(local), asUserUiLib(remote), tieBreak);
}

/** 单个同步键的合并策略（由存储键注册表提供） */
export interface CloudSyncKeyStrategy {
    /** 存储键名 */
    key: string;
    /** 三方合并该键的值 */
    merge: (base: unknown, local: unknown, remote: unknown, tieBreak?: MergeTieBreak) => unknown;
}

/**
 * 按策略逐键合并整个同步快照
 * base 为 null（首次同步，没有共同祖先）时各键退化为本地 / 远端并集合并。
 */
export function mergeSnapshots(
    strategies: readonly CloudSyncKeyStrategy[],
    base: SyncSnapshot | null,
    local: SyncSnapshot,
    remote: SyncSnapshot,
    tieBreak: MergeTieBreak = 'local'
): SyncSnapshot {
    const merged: SyncSnapshot = {};
    for (const { key, merge } of strategies) {
        merged[key] = merge(base?.[key], local[key], remote?.[key], tieBreak);
    }
    return merged;
}
