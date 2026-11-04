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

/**
 * 面板定高：macOS 设置窗口的「窗口不动、内容在列里滚」是这样长出来的——
 * 高度跟着内容长会让每个栏目的面板都换一次尺寸，整页滚动又会把左栏和标题一起带走。
 * 视口不够高时 calc 先收缩，所以永远不会出现页面级滚动条。
 */
const panelHeight = 'min(var(--panel-h), calc(100vh - var(--space-4) * 2))';

/** 外壳的正文区不再自己滚：滚动交给下面两个列，左栏才不会被带走 */
const bodyStyle = { padding: '0', overflow: 'hidden' };

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
        placement="center"
        size="xl"
        :max-height="panelHeight"
        :content-style="{ height: panelHeight }"
        :body-style="bodyStyle"
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
    // 外壳正文区改成不滚的容器后，这里 100% 才拿得到面板定高；
    // min-height: 0 是两列 overflow 真正生效的前提，否则列会被内容顶高、又开始整页滚
    height: 100%;
    min-height: 0;
}

.panel-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 0 0 var(--panel-nav-w);
    padding: var(--space-3);
    border-right: 1px solid var(--separator);
    // 栏目多到超出可视高度时左栏自己滚：标题和右栏都不会跟着被带走
    @include scrollable;

    &__item {
        @include button-reset;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-height: var(--control-h-md);
        padding: 0 var(--space-3);
        border-radius: var(--control-radius);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--label-secondary);
        text-align: left;
        @include spring-transition(color background, var(--dur-fast));

        &:hover {
            background: var(--hover-bg);
            color: var(--label);
        }

        // 选中行用强调色实底 + 反白，和主界面侧栏 rail 同一套语言：
        // 一栏里只有一个当前项，淡 tint 读不出「你在这」。
        &.active {
            @include accent-fill;
            font-weight: var(--weight-semibold);

            :deep(.icon-svg) {
                color: var(--on-accent);
            }
        }
    }
}

.panel-content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: var(--space-5);
    // 内容列比外壳暗一档，分组卡才读得出是浮在面上的一层
    background: var(--fill-tertiary);
    // 只有这一列滚：滚动条贴右边缘，标题栏与左栏保持不动
    @include scrollable;
}

@include respond-to(mobile) {
    .panel-layout {
        flex-direction: column;
        gap: 0;
    }

    .panel-nav {
        flex: none;
        flex-direction: row;
        border-right: none;
        border-bottom: 1px solid var(--separator);
        padding: var(--space-2) var(--space-3);
        overflow-x: auto;
        overflow-y: hidden;
        @include hide-scrollbar; // 横向胶囊条：栏目导航不需要滚动条

        &__item {
            white-space: nowrap;
        }
    }
}
</style>
