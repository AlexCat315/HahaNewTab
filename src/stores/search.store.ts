/**
 * 搜索状态管理（Pinia Store）
 *
 * 管理当前选中的搜索引擎索引与搜索历史，持久化统一走 usePersistentSlice。
 * 与原项目保持一致的数据结构：
 *   - selectedSearchEngine: number（搜索引擎在配置列表中的索引）
 *   - searchHistory: SearchHistoryItem[]（最多保留 10 条，按时间倒序）
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { storageManager } from '@/services/storage.service';
import { usePersistentSlice } from '@/composables/usePersistentSlice';
import { STORAGE_KEYS, type StorageValue } from '@/types/storage';

/** 搜索历史最大保留条数 */
const MAX_HISTORY_SIZE = 10;

/** 单条搜索历史记录 */
export interface SearchHistoryItem {
    query: string;
    time: number;
}

export const useSearchStore = defineStore('search', () => {
    // State
    const selectedEngineIndex = ref<number>(0);
    const history = ref<SearchHistoryItem[]>([]);
    const initialized = ref(false);

    // Getters
    const historyCount = computed(() => history.value.length);
    const isHistoryEmpty = computed(() => history.value.length === 0);

    /**
     * 规范化搜索引擎索引
     * 非负整数回退到 0，与原项目行为一致。
     */
    function normalizeEngineIndex(value: unknown): number {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed) && parsed >= 0) {
                return parsed;
            }
        }
        return 0;
    }

    /**
     * 规范化搜索历史数组
     *
     * 兼容旧版 string[] 与新版的 SearchHistoryItem[]，过滤空 query。
     * 旧版字符串会被转换为当前时间戳的 SearchHistoryItem，保留原有顺序。
     */
    function normalizeHistory(value: unknown): SearchHistoryItem[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value
            .map((item): SearchHistoryItem | null => {
                if (typeof item === 'string') {
                    const query = item.trim();
                    return query ? { query, time: Date.now() } : null;
                }

                if (item && typeof item === 'object') {
                    const raw = item as Partial<SearchHistoryItem>;
                    const query = typeof raw.query === 'string' ? raw.query.trim() : '';
                    const time = typeof raw.time === 'number' ? raw.time : Date.now();
                    return query ? { query, time } : null;
                }

                return null;
            })
            .filter((item): item is SearchHistoryItem => item !== null)
            // 云端合并只负责并集与排序，条数上限是本 store 的策略：
            // 不在这里裁剪，合并下发的历史就会比本机已有的更长。
            .slice(0, MAX_HISTORY_SIZE);
    }

    const slice = usePersistentSlice({
        label: 'SearchStore',
        keys: [
            {
                key: STORAGE_KEYS.SELECTED_SEARCH_ENGINE,
                apply: raw => {
                    selectedEngineIndex.value = normalizeEngineIndex(raw);
                },
                read: () => selectedEngineIndex.value
            },
            {
                key: STORAGE_KEYS.SEARCH_HISTORY,
                apply: raw => {
                    history.value = normalizeHistory(raw);
                },
                read: () => history.value
            }
        ]
    });

    // 首帧同步读快照：搜索引擎选择与历史都要在首次渲染前就位，
    // 等异步存储回来再纠正会让选择器先显示默认引擎再跳一下。
    slice.applyBoot();

    /**
     * 从持久化存储加载状态到 store
     */
    async function loadFromStorage(): Promise<void> {
        await slice.load();
        initialized.value = true;
    }

    /**
     * 设置当前选中的搜索引擎索引
     */
    async function setSelectedEngineIndex(index: number): Promise<void> {
        const nextIndex = normalizeEngineIndex(index);
        await slice.mutate(() => {
            selectedEngineIndex.value = nextIndex;
        });
    }

    /**
     * 将搜索关键词加入历史
     *
     * 写前重读持久化历史，避免旧缓存覆盖并发 / 跨标签页写入；
     * 重复查询会移动到最前并刷新时间戳，历史总量限制为 MAX_HISTORY_SIZE。
     */
    async function addHistory(query: string): Promise<void> {
        const trimmed = query.trim();
        if (!trimmed) {
            return;
        }

        const persisted = await storageManager.get(STORAGE_KEYS.SEARCH_HISTORY);
        const currentHistory = normalizeHistory(persisted);
        const filtered = currentHistory.filter(item => item.query !== trimmed);
        const nextHistory = [{ query: trimmed, time: Date.now() }, ...filtered].slice(
            0,
            MAX_HISTORY_SIZE
        );

        await slice.mutate(() => {
            history.value = nextHistory;
        });
    }

    /**
     * 从搜索历史中移除指定关键词
     */
    async function removeHistory(query: string): Promise<void> {
        const trimmed = query.trim();
        if (!trimmed) {
            return;
        }

        const persisted = await storageManager.get(STORAGE_KEYS.SEARCH_HISTORY);
        const currentHistory = normalizeHistory(persisted);
        const nextHistory = currentHistory.filter(item => item.query !== trimmed);

        if (nextHistory.length === currentHistory.length) {
            return;
        }

        await slice.mutate(() => {
            history.value = nextHistory;
        });
    }

    /**
     * 清空搜索历史
     */
    async function clearHistory(): Promise<void> {
        await slice.mutate(() => {
            history.value = [];
        });
    }

    /** 应用云同步下发的搜索历史（只认本 store 归属且出现在快照里的键） */
    async function applyCloudValues(values: Record<string, StorageValue | null>): Promise<boolean> {
        return slice.applyRemote(values);
    }

    return {
        selectedEngineIndex,
        history,
        historyCount,
        isHistoryEmpty,
        initialized,
        loadFromStorage,
        setSelectedEngineIndex,
        addHistory,
        removeHistory,
        clearHistory,
        applyCloudValues,
    };
});
