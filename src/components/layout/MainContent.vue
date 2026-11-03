<script setup lang="ts">
/**
 * MainContent - 内容区容器
 *
 * 居中限宽的一列内容，顶部与左侧为悬浮顶栏和 rail 让位。
 * 页头由标题 + 说明行（meta 插槽）+ 右侧操作（header-extra 插槽）组成，
 * 不再用底部分隔线和主色小横条——那两条线在新版里靠间距分层。
 */
export interface MainContentProps {
    /** 内容区标题 */
    title?: string;
    /** 是否显示内容头部 */
    showHeader?: boolean;
    /** 侧边栏是否折叠（用于调整 margin-left） */
    collapsed?: boolean;
}

withDefaults(defineProps<MainContentProps>(), {
    title: '',
    showHeader: true,
    collapsed: false
});
</script>

<template>
    <main class="main-content" :class="{ collapsed }">
        <div class="content-wrapper">
            <header v-if="showHeader" class="content-header">
                <div class="content-heading">
                    <h2 class="content-title">
                        <slot name="header-title">{{ title }}</slot>
                    </h2>
                    <div v-if="$slots.meta" class="content-meta">
                        <slot name="meta" />
                    </div>
                </div>
                <div class="header-extra">
                    <slot name="header-extra" />
                </div>
            </header>

            <div class="content-body">
                <slot />
            </div>
        </div>
    </main>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.main-content {
    // 左侧给浮动 rail 让位（rail 宽 + 两侧留边），顶部给悬浮顶栏让位
    margin-left: calc(var(--sidebar-width) + var(--shell-inset) * 2);
    padding: calc(var(--header-height) + var(--shell-inset) * 2) var(--shell-gap) var(--space-10);
    min-height: 100vh;
    @include md-transition(margin-left);
}

.main-content.collapsed {
    margin-left: calc(var(--sidebar-collapsed-width) + var(--shell-inset) * 2);
}

.content-wrapper {
    width: 100%;
    max-width: var(--content-max-width);
    margin: 0 auto;
}

.content-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
}

.content-heading {
    min-width: 0;
}

.content-title {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    color: var(--md-sys-color-on-surface);
    letter-spacing: var(--tracking-tight);
    line-height: var(--leading-tight);
    margin: 0;
    @include text-ellipsis;
}

.content-meta {
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    color: var(--md-sys-color-on-surface-variant);
}

.header-extra {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
}

.content-body {
    min-height: 200px;
}

@include respond-to(mobile) {
    .main-content {
        margin-left: 0 !important;
        padding: calc(var(--header-height) + var(--shell-inset) * 2) var(--space-3) var(--space-8);
    }

    .content-header {
        align-items: flex-start;
        flex-direction: column;
        gap: var(--space-3);
        margin-bottom: var(--space-5);
    }

    .header-extra {
        width: 100%;
    }

    .content-title {
        font-size: var(--text-xl);
    }
}
</style>
