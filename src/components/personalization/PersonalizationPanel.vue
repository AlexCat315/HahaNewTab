<script setup lang="ts">
/**
 * PersonalizationPanel - 个性化设置总面板
 *
 * 「左侧导航 + 右侧内容」的可扩展栏目结构，外壳复用 ModalOverlay。
 * 新增设置页只需在 tabs 数组中注册一项并添加对应内容区块。
 */
import { ref, watch, computed } from 'vue';
import IconSvg from '@/components/icon/IconSvg.vue';
import ModalOverlay from '@/components/common/ModalOverlay.vue';
import ThemeSelector from './ThemeSelector.vue';
import WallpaperSettings from './WallpaperSettings.vue';
import LayoutSettings from './LayoutSettings.vue';
import CacheSettings from './CacheSettings.vue';

/** 栏目注册表（新增设置页在此加一项） */
const tabs = [
    { id: 'theme', label: '主题', icon: 'palette' },
    { id: 'wallpaper', label: '壁纸', icon: 'picture' },
    { id: 'layout', label: '页面布局', icon: 'sort' },
    { id: 'cache', label: '缓存', icon: 'download' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export interface PersonalizationPanelProps {
    /** 是否显示面板，支持 v-model */
    modelValue: boolean;
    /** 面板标题 */
    title?: string;
    /** 子面板是否自动初始化对应 store */
    autoInit?: boolean;
    /** 打开时定位到的栏目 */
    tab?: TabId;
}

const props = withDefaults(defineProps<PersonalizationPanelProps>(), {
    title: '个性化设置',
    autoInit: true,
    tab: 'theme'
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'close'): void;
}>();

/** 当前激活栏目 */
const activeTab = ref<TabId>(props.tab);

const isOpen = computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value)
});

// 每次打开回到调用方指定的栏目，避免上次浏览的栏目影响这次的默认态
watch(
    () => props.modelValue,
    (value) => {
        if (value) activeTab.value = props.tab;
    },
    { immediate: true }
);
</script>

<template>
    <ModalOverlay
        v-model="isOpen"
        placement="top-right"
        size="lg"
        max-height="calc(100vh - var(--header-height) - var(--shell-inset) * 4)"
        @close="emit('close')"
    >
        <template #header>
            <IconSvg name="palette" size="var(--icon-sm)" color="var(--accent)" />
            <h3 class="personalization-title">{{ title }}</h3>
        </template>

        <slot>
            <div class="panel-layout">
                <nav class="panel-nav" aria-label="个性化栏目">
                    <button
                        v-for="tab in tabs"
                        :key="tab.id"
                        type="button"
                        class="panel-nav__item"
                        :class="{ active: activeTab === tab.id }"
                        :aria-current="activeTab === tab.id ? 'true' : undefined"
                        @click="activeTab = tab.id"
                    >
                        <IconSvg :name="tab.icon" size="var(--icon-xs)" monochrome />
                        <span>{{ tab.label }}</span>
                    </button>
                </nav>

                <div class="panel-content">
                    <div v-show="activeTab === 'theme'" class="panel-section">
                        <ThemeSelector :auto-init="autoInit" />
                    </div>
                    <div v-show="activeTab === 'wallpaper'" class="panel-section">
                        <WallpaperSettings :auto-init="autoInit" />
                    </div>
                    <div v-show="activeTab === 'layout'" class="panel-section">
                        <LayoutSettings />
                    </div>
                    <div v-show="activeTab === 'cache'" class="panel-section">
                        <CacheSettings />
                    </div>
                </div>
            </div>
        </slot>
    </ModalOverlay>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.personalization-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--label);
    margin: 0;
    line-height: var(--leading-tight);
}

.panel-layout {
    display: flex;
    gap: var(--space-4);
    min-height: var(--panel-body-min-h);
}

.panel-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    // 128px 是「最长栏目名(4 字) + --icon-xs 图标 + 左右 --space-3 padding」的贴合宽度；
    // 宽度档里最近的 --pop-w-min(180px) 会把 660px 面板的内容区挤得太窄，故留字面值
    flex: 0 0 128px;
    border-right: 1px solid var(--separator);
    padding-right: var(--space-3);

    &__item {
        @include button-reset;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-height: var(--control-h-md);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--label-secondary);
        text-align: left;
        @include spring-transition(color background, var(--dur-fast));

        &:hover {
            background: var(--hover-bg);
            color: var(--label);
        }

        &.active {
            background: var(--tint-primary);
            color: var(--on-tint);
            font-weight: var(--weight-semibold);

            :deep(.icon-svg) {
                color: var(--on-tint);
            }
        }
    }
}

.panel-content {
    flex: 1;
    min-width: 0;
}

@include respond-to(mobile) {
    .panel-layout {
        flex-direction: column;
        min-height: 0;
        gap: var(--space-3);
    }

    .panel-nav {
        flex-direction: row;
        flex: none;
        border-right: none;
        border-bottom: 1px solid var(--separator);
        padding-right: 0;
        padding-bottom: var(--space-2);
        overflow-x: auto;
        @include hide-scrollbar; // 横向胶囊条：栏目导航不需要滚动条

        &__item {
            white-space: nowrap;
        }
    }
}
</style>
