<script setup lang="ts">
/**
 * LayoutSettings - 页面布局设置
 *
 * 状态由 layout store 管理，改动即时生效并持久化。
 */
import { computed, onMounted } from 'vue';
import { useLayoutStore } from '@/stores/layout.store';
import type { LinkOpenMode } from '@/types/storage';
import SettingsSection from '@/components/common/SettingsSection.vue';
import SettingsRow from '@/components/common/SettingsRow.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import SwitchField from '@/components/common/SwitchField.vue';

const layoutStore = useLayoutStore();

/** 列数选项：'auto' 为按宽度自适应 */
const COLUMN_OPTIONS = [
    { value: 'auto', label: '自动' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 5, label: '5' },
    { value: 6, label: '6' },
];

/** 每页数量选项 */
const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

/** 链接打开方式选项 */
const OPEN_MODE_OPTIONS: Array<{ value: LinkOpenMode; label: string; hint: string }> = [
    { value: 'new-tab', label: '新标签页', hint: '保留当前新标签页，站点在右侧新标签打开' },
    { value: 'current-tab', label: '覆盖当前页', hint: '直接在当前标签页打开，新标签页被替换' },
];

/** 当前打开方式对应的说明文案 */
const openModeHint = computed(
    () => OPEN_MODE_OPTIONS.find((item) => item.value === layoutStore.openMode)?.hint ?? ''
);

onMounted(() => {
    void layoutStore.init();
});
</script>

<template>
    <div class="layout-settings" aria-label="页面布局">
        <SettingsSection title="卡片排列">
            <SettingsRow orientation="stacked" label="每行卡片数" hint="「自动」按页面宽度自适应列数">
                <SegmentedControl
                    :model-value="layoutStore.columns"
                    :options="COLUMN_OPTIONS"
                    aria-label="每行卡片数"
                    @update:model-value="layoutStore.setColumns($event as number | 'auto')"
                />
            </SettingsRow>

            <SettingsRow
                label="分页模式"
                hint="卡片过多时减少同屏数量，避免卡顿"
            >
                <SwitchField :model-value="layoutStore.paginate" @update:model-value="layoutStore.setPaginate" />
            </SettingsRow>

            <SettingsRow v-if="layoutStore.paginate" orientation="stacked" label="每页卡片数">
                <SegmentedControl
                    :model-value="layoutStore.pageSize"
                    :options="PAGE_SIZE_OPTIONS"
                    aria-label="每页卡片数"
                    @update:model-value="layoutStore.setPageSize($event as number)"
                />
            </SettingsRow>

            <SettingsRow label="站点图标背景" hint="关闭后图标背景透明">
                <SwitchField
                    :model-value="layoutStore.showIconBackground"
                    @update:model-value="layoutStore.setShowIconBackground"
                />
            </SettingsRow>
        </SettingsSection>

        <SettingsSection title="分类与导航">
            <SettingsRow label="显示「全部应用」分类" hint="关闭后侧栏只按分类显示">
                <SwitchField
                    :model-value="layoutStore.showAllCategory"
                    @update:model-value="layoutStore.setShowAllCategory"
                />
            </SettingsRow>

            <SettingsRow label="「全部应用」平铺显示" hint="不按分类分组，所有站点排成一个列表">
                <SwitchField :model-value="layoutStore.allViewFlat" @update:model-value="layoutStore.setAllViewFlat" />
            </SettingsRow>
        </SettingsSection>

        <SettingsSection title="打开行为">
            <SettingsRow orientation="stacked" label="链接打开方式" :hint="openModeHint">
                <SegmentedControl
                    :model-value="layoutStore.openMode"
                    :options="OPEN_MODE_OPTIONS"
                    aria-label="链接打开方式"
                    block
                    @update:model-value="layoutStore.setOpenMode($event as LinkOpenMode)"
                />
            </SettingsRow>
        </SettingsSection>

        <SettingsSection title="界面模式">
            <SettingsRow label="极简约模式" hint="隐藏侧边栏与顶栏，仅保留核心内容">
                <SwitchField :model-value="layoutStore.minimalMode" @update:model-value="layoutStore.setMinimalMode" />
            </SettingsRow>
        </SettingsSection>
    </div>
</template>

<style scoped lang="scss">
.layout-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
}
</style>
