<script setup lang="ts">
/**
 * AppHeader - 悬浮顶栏
 *
 * 贴在壁纸上的一块半透明浮层，不再是一条实色渐变带：
 * 左侧依次是折叠开关、移动端菜单按钮、品牌区，右侧留给 actions 插槽。
 * 个性化入口不在顶栏：已并入右下角 FAB 菜单（极简模式则由控制区的 palette 按钮提供）。
 */
import { computed } from 'vue';
import IconSvg from '@/components/icon/IconSvg.vue';
import { getBrandLogo } from '@/utils/browser.util';

export interface AppHeaderProps {
    /** 主标题 */
    title?: string;
    /** Logo 图片地址；不传时使用统一的 logo_girl */
    logoSrc?: string;
    /** 是否显示侧边栏折叠按钮 */
    showCollapseToggle?: boolean;
    /** 当前侧边栏是否折叠 */
    sidebarCollapsed?: boolean;
}

const props = withDefaults(defineProps<AppHeaderProps>(), {
    title: 'Haha新标签页',
    logoSrc: '',
    showCollapseToggle: true,
    sidebarCollapsed: false
});

const emit = defineEmits<{
    (e: 'toggle-sidebar'): void;
    (e: 'menu-click'): void;
    /** 双击品牌区（Logo / 标题）：用于切换隐藏站点揭示模式 */
    (e: 'brand-dblclick'): void;
}>();

/** 未显式传入 logoSrc 时使用统一的品牌 Logo */
const resolvedLogoSrc = computed(() => props.logoSrc || getBrandLogo());

const collapseIconName = computed(() => (props.sidebarCollapsed ? 'Expand' : 'Fold'));

function handleCollapseClick(): void {
    emit('toggle-sidebar');
}

function handleMenuClick(): void {
    emit('menu-click');
}

/**
 * 双击品牌区切换隐藏站点揭示模式
 *
 * 用模板事件绑定而非在父组件里手动 addEventListener：
 * 头部位于 `v-if / v-else` 分支中，进出极简模式会重建 DOM，
 * 手动绑定的监听器会随之丢失（这正是「双击 Logo 没反应」的原因）。
 */
function handleBrandDblclick(): void {
    emit('brand-dblclick');
}
</script>

<template>
    <header class="app-header">
        <div class="header-leading">
            <button
                v-if="showCollapseToggle"
                type="button"
                class="header-icon-btn collapse-toggle"
                :title="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
                :aria-label="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
                @click="handleCollapseClick"
            >
                <IconSvg :name="collapseIconName" size="var(--icon-sm)" monochrome />
            </button>

            <button
                type="button"
                class="header-icon-btn menu-toggle"
                title="打开菜单"
                aria-label="打开分类菜单"
                @click="handleMenuClick"
            >
                <IconSvg name="menu" size="var(--icon-sm)" monochrome />
            </button>

            <!-- 不加 title 提示：隐藏站点的入口刻意保持隐蔽，提示由 HiddenTipModal 负责 -->
            <div class="brand" @dblclick="handleBrandDblclick">
                <img class="brand-logo" :src="resolvedLogoSrc" alt="Haha" loading="lazy" />
                <h1 class="brand-title">{{ title }}</h1>
            </div>
        </div>

        <div class="header-actions">
            <slot name="actions" />
        </div>
    </header>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.app-header {
    position: fixed;
    top: var(--shell-inset);
    left: var(--shell-inset);
    right: var(--shell-inset);
    height: var(--header-height);
    @include glass-surface(var(--glass-bg), var(--radius-xl));
    padding: 0 var(--space-3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    z-index: var(--z-header);
    contain: layout;
}

.header-leading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
}

.header-icon-btn {
    // 顶栏 56 高，图标按钮取控件默认档（md），留得上下一圈呼吸
    @include icon-button;
    border-radius: var(--radius-sm);
}

.brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    /* 双击切换隐藏站点时不希望顺带选中标题文字 */
    user-select: none;
}

// 品牌图自带白底，按原图显示只做圆角裁切，不加内边距/边框/投影
.brand-logo {
    width: var(--icon-lg);
    height: var(--icon-lg);
    border-radius: var(--radius-sm);
    object-fit: contain;
    flex-shrink: 0;
    display: block;
}

.brand-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--md-sys-color-on-surface);
    letter-spacing: var(--tracking-tight);
    line-height: var(--leading-tight);
    margin: 0;
    @include text-ellipsis;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
}

.menu-toggle {
    display: none;
}

@include respond-to(mobile) {
    .app-header {
        top: var(--shell-inset);
        left: var(--shell-inset);
        right: var(--shell-inset);
        padding: 0 var(--space-2);
    }

    .collapse-toggle {
        display: none;
    }

    .menu-toggle {
        display: flex;
    }

    .brand-logo {
        // 移动端顶栏矮一档，logo 底板按间距阶收一格
        width: calc(var(--icon-lg) - var(--space-1));
        height: calc(var(--icon-lg) - var(--space-1));
    }

    .brand-title {
        font-size: var(--text-md);
    }
}
</style>
