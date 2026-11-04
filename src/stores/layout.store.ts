/**
 * layout.store
 * 页面布局设置（列数 / 分页 / 极简约模式 / 打开方式）的状态管理与持久化。
 *
 * 持久化走 usePersistentSlice（键 LAYOUT_SETTINGS，注册表标记为首帧键）；
 * isMobile 通过 matchMedia 监听视口宽度（<768px 时列数强制自适应）。
 */

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { usePersistentSlice } from '@/composables/usePersistentSlice';
import { STORAGE_KEYS, type LayoutSettings, type LinkOpenMode, type StorageValue } from '@/types/storage';
import { DEFAULT_OPEN_MODE, isLinkOpenMode } from '@/utils/navigation.util';

const DEFAULT_COLUMNS: number | 'auto' = 'auto';
const DEFAULT_PAGE_SIZE = 24;
const MOBILE_MEDIA_QUERY = '(max-width: 768px)';

export const useLayoutStore = defineStore('layout', () => {
    const columns = ref<number | 'auto'>(DEFAULT_COLUMNS);
    const paginate = ref(false);
    const pageSize = ref(DEFAULT_PAGE_SIZE);
    const showAllCategory = ref(true);
    const allViewFlat = ref(false);
    const showIconBackground = ref(true);
    const minimalMode = ref(false);
    const openMode = ref<LinkOpenMode>(DEFAULT_OPEN_MODE);
    const initialized = ref(false);
    const isMobile = ref(false);

    /**
     * 把一份（可能不完整 / 来自旧版本的）设置合并进当前状态。
     *
     * 字段缺失或取值非法时保持原值，因此可以安全地拿「同步镜像」和
     * 「storage 里的真实值」各调一次，后调的自然覆盖前调的。
     */
    function applySettings(saved: Partial<LayoutSettings> | null | undefined): void {
        if (!saved || typeof saved !== 'object') return;

        if (
            saved.columns === 'auto' ||
            (typeof saved.columns === 'number' && saved.columns >= 1 && saved.columns <= 12)
        ) {
            columns.value = saved.columns;
        }
        if (typeof saved.paginate === 'boolean') {
            paginate.value = saved.paginate;
        }
        if (typeof saved.pageSize === 'number' && saved.pageSize > 0) {
            pageSize.value = saved.pageSize;
        }
        if (typeof saved.showAllCategory === 'boolean') {
            showAllCategory.value = saved.showAllCategory;
        }
        if (typeof saved.allViewFlat === 'boolean') {
            allViewFlat.value = saved.allViewFlat;
        }
        if (typeof saved.showIconBackground === 'boolean') {
            showIconBackground.value = saved.showIconBackground;
        }
        if (typeof saved.minimalMode === 'boolean') {
            minimalMode.value = saved.minimalMode;
        }
        if (isLinkOpenMode(saved.openMode)) {
            openMode.value = saved.openMode;
        }
    }

    /**
     * 当前状态对应的完整设置对象（持久化用）
     *
     * 字段缺失或取值非法时 applySettings 保持原值，因此可以安全地拿
     * 「首帧快照」和「storage 里的真实值」各调一次，后调的自然覆盖前调的。
     */
    function buildSettings(): LayoutSettings {
        return {
            columns: columns.value,
            paginate: paginate.value,
            pageSize: pageSize.value,
            showAllCategory: showAllCategory.value,
            allViewFlat: allViewFlat.value,
            showIconBackground: showIconBackground.value,
            minimalMode: minimalMode.value,
            openMode: openMode.value,
        };
    }

    const slice = usePersistentSlice({
        label: 'LayoutStore',
        keys: [
            {
                key: STORAGE_KEYS.LAYOUT_SETTINGS,
                apply: raw => applySettings(raw as Partial<LayoutSettings> | null),
                read: buildSettings
            }
        ]
    });

    // 首屏同步兜底：必须在第一次渲染前完成。
    // storage.local 是异步的，等它返回再渲染，首帧会先画出默认的「标准三栏布局」
    // 随后才切成极简约模式——用户看到的就是打开新标签页时闪一下。
    slice.applyBoot();

    let mediaQueryList: MediaQueryList | null = null;
    let mediaListener: ((event: MediaQueryListEvent) => void) | null = null;

    /**
     * 监听视口宽度变化（jsdom 等无 matchMedia 的环境下保持 isMobile=false）
     */
    function setupMediaListener(): void {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        mediaQueryList = window.matchMedia(MOBILE_MEDIA_QUERY);
        isMobile.value = mediaQueryList.matches;
        mediaListener = (event: MediaQueryListEvent) => {
            isMobile.value = event.matches;
        };
        mediaQueryList.addEventListener('change', mediaListener);
    }

    /**
     * 加载布局设置（幂等）
     *
     * 首屏已经用首帧快照铺过一遍，这里读到真实存储后再校正一次；
     * 两者一致时不会触发任何重渲染，因此不会产生二次闪烁。
     */
    async function init(): Promise<void> {
        if (initialized.value) return;
        setupMediaListener();
        try {
            await slice.load();
            initialized.value = true;
        } catch (error) {
            console.error('[LayoutStore] 加载布局设置失败:', error);
        }
    }

    async function setColumns(value: number | 'auto'): Promise<void> {
        await slice.mutate(() => {
            columns.value = value;
        });
    }

    async function setPaginate(value: boolean): Promise<void> {
        await slice.mutate(() => {
            paginate.value = value;
        });
    }

    async function setPageSize(value: number): Promise<void> {
        if (value <= 0) return;
        await slice.mutate(() => {
            pageSize.value = value;
        });
    }

    async function setShowAllCategory(value: boolean): Promise<void> {
        await slice.mutate(() => {
            showAllCategory.value = value;
        });
    }

    async function setAllViewFlat(value: boolean): Promise<void> {
        await slice.mutate(() => {
            allViewFlat.value = value;
        });
    }

    async function setShowIconBackground(value: boolean): Promise<void> {
        await slice.mutate(() => {
            showIconBackground.value = value;
        });
    }

    async function setMinimalMode(value: boolean): Promise<void> {
        await slice.mutate(() => {
            minimalMode.value = value;
        });
    }

    async function setOpenMode(value: LinkOpenMode): Promise<void> {
        if (!isLinkOpenMode(value)) return;
        await slice.mutate(() => {
            openMode.value = value;
        });
    }

    /** 应用云同步下发的布局设置（只认本 store 归属的键） */
    async function applyCloudValues(values: Record<string, StorageValue | null>): Promise<boolean> {
        return slice.applyRemote(values);
    }

    return {
        columns,
        paginate,
        pageSize,
        showAllCategory,
        allViewFlat,
        showIconBackground,
        minimalMode,
        openMode,
        isMobile,
        initialized,
        init,
        setColumns,
        setPaginate,
        setPageSize,
        setShowAllCategory,
        setAllViewFlat,
        setShowIconBackground,
        setMinimalMode,
        setOpenMode,
        applyCloudValues,
    };
});
