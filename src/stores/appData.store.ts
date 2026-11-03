/**
 * 应用数据 Store
 * 管理应用分类、站点数据以及用户 UI 图标库。
 * 作为 CloudSyncService 的 ICloudSyncDataManager 适配器实现 syncNow / applyStorageSnapshot。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { storageManager } from '@/services/storage.service';
import { loadDefaultData } from '@/services/config.service';
import { generateAppId, generateCategoryId } from '@/utils/id.util';
import { normalizeUrl, getUrlKey } from '@/utils/url.util';
import { normalizeNameKey } from '@/utils/name.util';
import type { AppNavigatorData, AppItem, Category, AppInput, CategoryInput } from '@/types/app';
import type { UserUiLib } from '@/types/ui';
import type { BackupData, StorageValue } from '@/types/storage';
import { STORAGE_KEYS } from '@/types/storage';

/** “全部应用”兜底分类，使用系统 SVG 图标 */
function createDefaultAllCategory(): Category {
    return {
        id: 'all',
        name: '全部应用',
        icon: './image/icons/menu.svg',
        monochrome: true
    };
}

/** 默认空用户图标库 */
const DEFAULT_USER_UI_LIB: UserUiLib = { categories: [], items: [] };

/** 判断是否为合法主数据 */
function isMainData(data: unknown): data is AppNavigatorData {
    return Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray((data as AppNavigatorData).categories) &&
        Array.isArray((data as AppNavigatorData).apps)
    );
}

/** 判断是否为合法用户图标库 */
function isUserUiLib(data: unknown): data is UserUiLib {
    return Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray((data as UserUiLib).categories) &&
        Array.isArray((data as UserUiLib).items)
    );
}

/** 深度克隆（使用 JSON 序列化，兼容 Vue reactive proxy） */
function clone<T>(value: T): T {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/** 生成可安全持久化的普通对象快照，彻底剥离 Vue reactive proxy */
function plainSnapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** 比较两个值是否相等 */
function valuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch (_) {
        return false;
    }
}

/**
 * 补齐“全部应用”分类，并修复孤儿站点
 *
 * 站点引用的分类可能已经不存在（删分类、同步合并、导入旧备份都会造成），
 * 那样它在任何分类视图里都渲染不出来，用户眼里就是“站点凭空丢了”。
 * 一律重指到“全部应用”，至少保证站点始终可见。
 */
function normalizeMainData(data: AppNavigatorData): AppNavigatorData {
    const normalized = clone(data);
    if (!normalized.categories.some((category) => category.id === 'all')) {
        normalized.categories.unshift(clone(createDefaultAllCategory()));
    }
    const categoryIds = new Set(normalized.categories.map((category) => category.id));
    for (const app of normalized.apps) {
        if (!categoryIds.has(app.category)) {
            app.category = 'all';
        }
    }
    return normalized;
}

/** 写锁名称 */
const WRITE_LOCK = 'haha-newtab-data-write';

/**
 * 校验站点 URL 是否与已有站点重复
 *
 * 按 getUrlKey 比较，`https://a.com`、`https://a.com/`、`http://www.a.com` 视为同一站点。
 * 编辑场景通过 excludeId 排除自身。
 *
 * @throws 存在重复时抛出可直接展示给用户的错误
 */
function assertAppUrlUnique(
    draft: AppNavigatorData,
    url: string,
    excludeId?: string
): void {
    const key = getUrlKey(url);
    if (!key) return;

    const duplicate = draft.apps.find(
        (app) => app.id !== excludeId && getUrlKey(app.url) === key
    );
    if (!duplicate) return;

    const categoryName =
        draft.categories.find((category) => category.id === duplicate.category)?.name ?? '未分类';
    throw new Error(`该网站已存在：${duplicate.name}（分类：${categoryName}）`);
}

/**
 * 校验分类名称是否重复
 *
 * 忽略首尾空白、连续空白、大小写差异。
 *
 * @throws 存在同名分类时抛出可直接展示给用户的错误
 */
function assertCategoryNameUnique(
    draft: AppNavigatorData,
    name: string,
    excludeId?: string
): void {
    const key = normalizeNameKey(name);
    if (!key) return;

    const duplicate = draft.categories.find(
        (category) => category.id !== excludeId && normalizeNameKey(category.name) === key
    );
    if (duplicate) {
        throw new Error(`分类「${duplicate.name}」已存在，请换一个名称`);
    }
}

export const useAppDataStore = defineStore('appData', () => {
    // ==================== State ====================
    const data = ref<AppNavigatorData>(normalizeMainData({ categories: [], apps: [] }));
    const userUiLib = ref<UserUiLib>({ categories: [], items: [] });
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const initialized = ref(false);

    /** 写操作队列（同一 Store 实例内串行化） */
    let writeQueue: Promise<unknown> = Promise.resolve();

    // ==================== Getters ====================
    const categories = computed(() => data.value.categories);
    const apps = computed(() => data.value.apps);
    const visibleApps = computed(() => apps.value.filter((app) => !app.hidden));
    const hiddenApps = computed(() => apps.value.filter((app) => app.hidden));
    const userCategories = computed(() => categories.value.filter((category) => category.id !== 'all'));
    const allCategory = computed(() => categories.value.find((category) => category.id === 'all'));
    const dataSnapshot = computed(() => plainSnapshot(data.value));

    function getAppsByCategory(categoryId: string): AppItem[] {
        return apps.value.filter((app) => app.category === categoryId);
    }

    function getCategoryById(id: string): Category | undefined {
        return categories.value.find((category) => category.id === id);
    }

    /**
     * 按 URL 查找已存在的站点
     *
     * @param url 待查 URL，内部会做规范化
     * @param excludeId 需要排除的站点 ID（编辑时排除自身）
     */
    function findAppByUrl(url: string, excludeId?: string): AppItem | undefined {
        const key = getUrlKey(url);
        if (!key) return undefined;
        return apps.value.find((app) => app.id !== excludeId && getUrlKey(app.url) === key);
    }

    /**
     * 按名称查找已存在的分类
     *
     * @param name 待查名称，内部会做空白与大小写归一
     * @param excludeId 需要排除的分类 ID（改名时排除自身）
     */
    function findCategoryByName(name: string, excludeId?: string): Category | undefined {
        const key = normalizeNameKey(name);
        if (!key) return undefined;
        return categories.value.find(
            (category) => category.id !== excludeId && normalizeNameKey(category.name) === key
        );
    }

    // ==================== Internal Helpers ====================

    /**
     * 派发数据变更事件
     */
    function emitChange(kind: 'data' | 'uiLib', source: 'local' | 'external' | 'cloud') {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(
            new CustomEvent('appNavigator:data-changed', {
                detail: { kind, source }
            })
        );
    }

    /**
     * 在写锁保护下执行任务
     */
    function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
        if (typeof navigator !== 'undefined' && navigator.locks) {
            return navigator.locks.request(WRITE_LOCK, { mode: 'exclusive' }, () => task()) as Promise<T>;
        }
        const result = writeQueue.then(task, task) as Promise<T>;
        writeQueue = result.catch(() => undefined);
        return result;
    }

    /**
     * 提交主数据变更，失败时回滚内存状态
     */
    async function commitMain(nextData: AppNavigatorData): Promise<void> {
        if (!isMainData(nextData)) {
            throw new TypeError('应用数据格式无效');
        }
        const normalized = normalizeMainData(nextData);
        const snapshot = plainSnapshot(normalized);
        const previous = data.value;

        data.value = normalized;

        try {
            await storageManager.setMany({
                [STORAGE_KEYS.MAIN_DATA]: snapshot,
                [STORAGE_KEYS.DATA_UPDATED_AT]: Date.now()
            });
        } catch (e) {
            data.value = previous;
            throw e;
        }
    }

    /**
     * 提交用户图标库变更，失败时回滚内存状态
     */
    async function commitUserUiLib(nextUiLib: UserUiLib): Promise<void> {
        if (!isUserUiLib(nextUiLib)) {
            throw new TypeError('用户图标库格式无效');
        }
        const snapshot = plainSnapshot(nextUiLib);
        const previous = userUiLib.value;

        userUiLib.value = snapshot;

        try {
            await storageManager.setMany({
                [STORAGE_KEYS.USER_UI_LIB]: snapshot,
                [STORAGE_KEYS.DATA_UPDATED_AT]: Date.now()
            });
        } catch (e) {
            userUiLib.value = previous;
            throw e;
        }
    }

    /**
     * 在主数据上执行变更（写前重读最新持久化快照）
     */
    async function mutateMain<T>(mutator: (draft: AppNavigatorData) => T): Promise<T> {
        await init();
        return withWriteLock(async () => {
            const persisted = (await storageManager.get(STORAGE_KEYS.MAIN_DATA)) as AppNavigatorData | null;
            const draft = isMainData(persisted)
                ? clone(persisted)
                : dataSnapshot.value;
            const normalizedDraft = normalizeMainData(draft);
            const result = mutator(normalizedDraft);
            await commitMain(normalizedDraft);
            return clone(result);
        });
    }

    // ==================== Actions ====================

    /**
     * 初始化：从存储加载数据，缺失时回退到 defaultData.json
     */
    async function init(): Promise<void> {
        if (initialized.value) return;
        isLoading.value = true;
        error.value = null;

        try {
            const [savedData, savedUiLib, defaultDataConfig] = await Promise.all([
                storageManager.get(STORAGE_KEYS.MAIN_DATA),
                storageManager.get(STORAGE_KEYS.USER_UI_LIB),
                loadDefaultData()
            ]);

            const defaultMainData = defaultDataConfig?.appNavigator || { categories: [], apps: [] };

            let nextMain: AppNavigatorData;
            if (isMainData(savedData)) {
                nextMain = normalizeMainData(savedData);
            } else {
                nextMain = normalizeMainData(defaultMainData);
            }

            const nextUiLib = isUserUiLib(savedUiLib)
                ? clone(savedUiLib)
                : clone(DEFAULT_USER_UI_LIB);

            data.value = nextMain;
            userUiLib.value = nextUiLib;

            if (!isMainData(savedData) || !valuesEqual(savedData, nextMain) || !isUserUiLib(savedUiLib)) {
                // 首次落盘/补齐属于加载，不算用户改动，所以不打 DATA_UPDATED_AT：
                // 云同步要靠它分辨「本机真的编辑过」和「出厂默认数据」，
                // 一装机就把时间戳刷成当前，新设备就会在首次同步时把云端已有数据覆盖掉
                await storageManager.setMany({
                    [STORAGE_KEYS.MAIN_DATA]: plainSnapshot(nextMain),
                    [STORAGE_KEYS.USER_UI_LIB]: plainSnapshot(nextUiLib)
                });
            }

            initialized.value = true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 强制重新加载存储中的最新数据
     */
    async function loadData(): Promise<void> {
        const saved = (await storageManager.get(STORAGE_KEYS.MAIN_DATA)) as AppNavigatorData | null;
        if (isMainData(saved)) {
            data.value = normalizeMainData(saved);
        }
        initialized.value = true;
    }

    /**
     * 将当前内存数据立即持久化
     *
     * 只是给云同步刷一遍盘，不算用户改动，所以不打 DATA_UPDATED_AT：
     * 首次同步要靠这个时间戳判断本地到底有没有被编辑过。
     */
    async function syncNow(): Promise<void> {
        await storageManager.setMany({
            [STORAGE_KEYS.MAIN_DATA]: plainSnapshot(data.value),
            [STORAGE_KEYS.USER_UI_LIB]: plainSnapshot(userUiLib.value)
        });
    }

    /**
     * 将云端快照应用到本地
     */
    async function applyStorageSnapshot(snapshot: Record<string, unknown>): Promise<boolean> {
        const nextMain = snapshot[STORAGE_KEYS.MAIN_DATA];
        const nextUi = snapshot[STORAGE_KEYS.USER_UI_LIB];
        const hasMain = Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEYS.MAIN_DATA);
        const hasUi = Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEYS.USER_UI_LIB);

        if (hasMain && !isMainData(nextMain)) {
            throw new TypeError('云端应用数据格式无效');
        }
        if (hasUi && !isUserUiLib(nextUi)) {
            throw new TypeError('云端图标库格式无效');
        }
        if (!hasMain && !hasUi) {
            return false;
        }

        const previousMain = data.value;
        const previousUi = userUiLib.value;

        if (hasMain) data.value = normalizeMainData(clone(nextMain) as AppNavigatorData);
        if (hasUi) userUiLib.value = clone(nextUi) as UserUiLib;

        try {
            const writes: Record<string, StorageValue> = {
                [STORAGE_KEYS.DATA_UPDATED_AT]: Date.now()
            };
            if (hasMain) writes[STORAGE_KEYS.MAIN_DATA] = plainSnapshot(data.value);
            if (hasUi) writes[STORAGE_KEYS.USER_UI_LIB] = plainSnapshot(userUiLib.value);
            await storageManager.setMany(writes);
            emitChange(hasMain ? 'data' : 'uiLib', 'cloud');
            return true;
        } catch (e) {
            data.value = previousMain;
            userUiLib.value = previousUi;
            throw e;
        }
    }

    /**
     * 保存主数据
     */
    async function saveData(newData: AppNavigatorData): Promise<void> {
        await init();
        return withWriteLock(async () => {
            await commitMain(newData);
            emitChange('data', 'local');
        });
    }

    /**
     * 保存用户 UI 图标库
     */
    async function saveUserUiLib(newUserUiLib: UserUiLib): Promise<void> {
        await init();
        return withWriteLock(async () => {
            await commitUserUiLib(newUserUiLib);
            emitChange('uiLib', 'local');
        });
    }

    /**
     * 添加应用
     *
     * URL 会先规范化再入库；与已有站点指向同一站点时拒绝添加并抛错。
     */
    async function addApp(app: AppInput): Promise<AppItem> {
        return mutateMain((draft) => {
            const url = normalizeUrl(app.url);
            assertAppUrlUnique(draft, url);

            const newApp: AppItem = {
                ...clone(app),
                url,
                id: generateAppId()
            };
            draft.apps.push(newApp);
            return newApp;
        });
    }

    /**
     * 更新应用
     *
     * 改动 URL 时会重新校验重复（排除自身）。
     */
    async function updateApp(id: string, updates: Partial<Omit<AppItem, 'id'>>): Promise<AppItem | null> {
        return mutateMain((draft) => {
            const index = draft.apps.findIndex((app) => app.id === id);
            if (index === -1) return null;

            const patch = clone(updates);
            if (typeof patch.url === 'string') {
                patch.url = normalizeUrl(patch.url);
                assertAppUrlUnique(draft, patch.url, id);
            }

            draft.apps[index] = { ...draft.apps[index], ...patch, id };
            return draft.apps[index];
        });
    }

    /**
     * 删除应用
     */
    async function deleteApp(id: string): Promise<boolean> {
        return mutateMain((draft) => {
            const before = draft.apps.length;
            draft.apps = draft.apps.filter((app) => app.id !== id);
            return draft.apps.length !== before;
        });
    }

    /**
     * 按 ID 排序应用
     */
    async function updateAppsOrder(orderedIds: string[]): Promise<void> {
        return mutateMain((draft) => {
            const appsById = new Map(draft.apps.map((app) => [app.id, app]));
            const ordered: AppItem[] = [];
            for (const id of orderedIds) {
                if (appsById.has(id)) {
                    ordered.push(appsById.get(id)!);
                    appsById.delete(id);
                }
            }
            draft.apps = [...ordered, ...appsById.values()];
        });
    }

    /**
     * 添加分类
     *
     * 名称忽略大小写与空白差异后重复时拒绝创建。
     */
    async function addCategory(category: CategoryInput): Promise<Category> {
        return mutateMain((draft) => {
            assertCategoryNameUnique(draft, category.name);

            const newCategory: Category = {
                ...clone(category),
                name: category.name.trim(),
                id: generateCategoryId()
            };
            if (!newCategory.icon) {
                newCategory.icon = './image/icons/folder.svg';
            }
            draft.categories.push(newCategory);
            return newCategory;
        });
    }

    /**
     * 更新分类
     *
     * 改名时会重新校验同名冲突（排除自身）。
     */
    async function updateCategory(id: string, updates: Partial<Omit<Category, 'id'>>): Promise<Category | null> {
        return mutateMain((draft) => {
            const index = draft.categories.findIndex((category) => category.id === id);
            if (index === -1) return null;

            const patch = clone(updates);
            if (typeof patch.name === 'string') {
                assertCategoryNameUnique(draft, patch.name, id);
                patch.name = patch.name.trim();
            }

            draft.categories[index] = { ...draft.categories[index], ...patch, id };
            return draft.categories[index];
        });
    }

    /**
     * 删除分类（禁止删除“全部应用”）
     *
     * 只删分类，不删站点：分类下的站点归回“全部应用”。
     */
    async function deleteCategory(id: string): Promise<boolean> {
        if (id === 'all') return false;
        return mutateMain((draft) => {
            const before = draft.categories.length;
            draft.categories = draft.categories.filter((category) => category.id !== id);
            for (const app of draft.apps) {
                if (app.category === id) {
                    app.category = 'all';
                }
            }
            return draft.categories.length !== before;
        });
    }

    /**
     * 按 ID 排序分类（保持“全部应用”在最前）
     */
    async function updateCategoriesOrder(orderedIds: string[]): Promise<void> {
        return mutateMain((draft) => {
            const all = draft.categories.find((category) => category.id === 'all');
            const categoriesById = new Map(
                draft.categories
                    .filter((category) => category.id !== 'all')
                    .map((category) => [category.id, category])
            );
            const ordered: Category[] = [];
            for (const id of orderedIds) {
                if (categoriesById.has(id)) {
                    ordered.push(categoriesById.get(id)!);
                    categoriesById.delete(id);
                }
            }
            draft.categories = [...(all ? [all] : []), ...ordered, ...categoriesById.values()];
        });
    }

    /**
     * 导出当前数据
     */
    async function exportData(): Promise<BackupData> {
        await init();
        return {
            data: clone(data.value),
            userUiLib: clone(userUiLib.value),
            exportTime: new Date().toISOString(),
            version: '2.0'
        };
    }

    /**
     * 导入备份数据
     */
    async function importData(backup: BackupData): Promise<void> {
        await init();
        const importedMain = backup.data || null;
        const importedUi = backup.userUiLib || null;

        if (importedMain && !isMainData(importedMain)) {
            throw new TypeError('备份中的应用数据格式无效');
        }
        if (importedUi && !isUserUiLib(importedUi)) {
            throw new TypeError('备份中的图标库格式无效');
        }
        if (!importedMain && !importedUi) {
            throw new TypeError('未找到可导入的数据');
        }

        await withWriteLock(async () => {
            const previousMain = data.value;
            const previousUi = userUiLib.value;

            if (importedMain) data.value = normalizeMainData(clone(importedMain));
            if (importedUi) userUiLib.value = clone(importedUi);

            try {
                const writes: Record<string, StorageValue> = {
                    [STORAGE_KEYS.DATA_UPDATED_AT]: Date.now()
                };
                if (importedMain) writes[STORAGE_KEYS.MAIN_DATA] = plainSnapshot(data.value);
                if (importedUi) writes[STORAGE_KEYS.USER_UI_LIB] = plainSnapshot(userUiLib.value);
                await storageManager.setMany(writes);
                emitChange(importedMain ? 'data' : 'uiLib', 'local');
            } catch (e) {
                data.value = previousMain;
                userUiLib.value = previousUi;
                throw e;
            }
        });
    }

    /**
     * 恢复默认数据
     */
    async function resetToDefault(): Promise<void> {
        const defaultDataConfig = await loadDefaultData();
        const defaultMain = defaultDataConfig?.appNavigator || { categories: [], apps: [] };
        await importData({ data: defaultMain, userUiLib: { categories: [], items: [] } });
    }

    /**
     * 订阅外部存储变更
     */
    function subscribeToExternalChanges(): () => void {
        return storageManager.subscribe((changes) => {
            const mainChange = changes[STORAGE_KEYS.MAIN_DATA];
            if (mainChange && isMainData(mainChange.newValue)) {
                data.value = normalizeMainData(mainChange.newValue as AppNavigatorData);
            }
            const uiChange = changes[STORAGE_KEYS.USER_UI_LIB];
            if (uiChange && isUserUiLib(uiChange.newValue)) {
                userUiLib.value = uiChange.newValue as UserUiLib;
            }
        });
    }

    return {
        data,
        userUiLib,
        isLoading,
        error,
        initialized,
        categories,
        apps,
        visibleApps,
        hiddenApps,
        userCategories,
        allCategory,
        dataSnapshot,
        getAppsByCategory,
        getCategoryById,
        findAppByUrl,
        findCategoryByName,
        init,
        loadData,
        syncNow,
        applyStorageSnapshot,
        saveData,
        saveUserUiLib,
        addApp,
        updateApp,
        deleteApp,
        updateAppsOrder,
        addCategory,
        updateCategory,
        deleteCategory,
        updateCategoriesOrder,
        exportData,
        importData,
        resetToDefault,
        subscribeToExternalChanges
    };
});
