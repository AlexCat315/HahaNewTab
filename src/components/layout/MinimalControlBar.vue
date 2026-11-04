<script setup lang="ts">
/**
 * MinimalControlBar - 极简约首页的右下角控制区
 *
 * 默认只露一个锚点按钮，悬停/聚焦时向左展开成一排图标按钮，纯呈现无状态，
 * 所以动作全部原样抛给首页（首页再抛给 App.vue 的面板/弹层）。
 *
 * 放右下角而不是右上角：Toast 固定在右上角，站点操作后的提示会盖住控制区。
 */
import IconSvg from '@/components/icon/IconSvg.vue';

export interface MinimalControlBarProps {
    /** 是否处于隐藏站点揭示模式（决定眼睛图标与高亮态） */
    showHidden?: boolean;
}

withDefaults(defineProps<MinimalControlBarProps>(), {
    showHidden: false
});

const emit = defineEmits<{
    (e: 'add-app'): void;
    (e: 'open-full-search'): void;
    (e: 'open-cloud-sync'): void;
    (e: 'toggle-hidden-reveal'): void;
    (e: 'open-personalization'): void;
    (e: 'exit-minimal'): void;
}>();
</script>

<template>
    <div class="minimal-controls">
        <div class="minimal-controls__actions">
            <button type="button" class="minimal-controls__btn" title="添加站点" @click="emit('add-app')">
                <IconSvg name="plus" size="var(--icon-sm)" monochrome alt="" />
            </button>
            <button type="button" class="minimal-controls__btn" title="完整搜索与历史" @click="emit('open-full-search')">
                <IconSvg name="search" size="var(--icon-sm)" monochrome alt="" />
            </button>
            <button type="button" class="minimal-controls__btn" title="云同步" @click="emit('open-cloud-sync')">
                <IconSvg name="cloud" size="var(--icon-sm)" monochrome alt="" />
            </button>
            <button
                type="button"
                class="minimal-controls__btn"
                :class="{ 'is-active': showHidden }"
                :title="showHidden ? '恢复隐藏站点 (Alt+Shift+H)' : '显示隐藏站点 (Alt+Shift+H)'"
                :aria-pressed="showHidden"
                @click="emit('toggle-hidden-reveal')"
            >
                <IconSvg :name="showHidden ? 'eye' : 'eye-off'" size="var(--icon-sm)" monochrome alt="" />
            </button>
            <button type="button" class="minimal-controls__btn" title="个性化设置" @click="emit('open-personalization')">
                <IconSvg name="palette" size="var(--icon-sm)" monochrome alt="" />
            </button>
            <button type="button" class="minimal-controls__btn" title="退出极简约模式 (Alt+Shift+M)" @click="emit('exit-minimal')">
                <IconSvg name="Expand" size="var(--icon-sm)" monochrome alt="" />
            </button>
        </div>

        <button
            type="button"
            class="minimal-controls__trigger"
            title="更多操作"
            aria-label="更多操作"
        >
            <IconSvg name="setting" size="var(--icon-sm)" monochrome alt="" />
        </button>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.minimal-controls {
    position: fixed;
    right: var(--shell-inset);
    bottom: var(--shell-inset);
    display: flex;
    align-items: center;
    padding: var(--space-1);
    @include glass-surface(var(--glass-bg-strong), var(--shell-radius));
    // 默认灰暗隐藏
    opacity: 0.25;
    @include spring-transition(opacity, var(--dur-fast));

    &:hover,
    &:focus-within {
        opacity: 1;
    }
}

// 折叠态：宽度收为 0，悬停时向左展开
.minimal-controls__actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    max-width: 0;
    margin-right: 0;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    @include spring-transition(all, var(--dur-fast));
}

.minimal-controls:hover .minimal-controls__actions,
.minimal-controls:focus-within .minimal-controls__actions {
    // 展开宽度取轻浮层的上限档：够排下全部图标按钮，又不超出浮层的尺寸语言
    max-width: var(--pop-w-max);
    margin-right: var(--space-1);
    opacity: 1;
    pointer-events: auto;
}

.minimal-controls__btn,
.minimal-controls__trigger {
    @include button-reset;
    width: var(--control-h-sm);
    height: var(--control-h-sm);
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--label-secondary);
    @include spring-transition(all, var(--dur-fast));

    &:hover {
        background: var(--fill-secondary);
        color: var(--label);
    }

    // 揭示模式开启时高亮，避免用户忘了自己还开着
    &.is-active {
        @include accent-fill;
    }
}

// 触发器：始终可见，作为展开的锚点
.minimal-controls__trigger {
    cursor: default;
}

@include respond-to(mobile) {
    // 触屏没有 hover，直接常驻展开，隐藏锚点按钮
    .minimal-controls__actions {
        max-width: var(--pop-w-max);
        margin-right: 0;
        opacity: 1;
        pointer-events: auto;
    }

    .minimal-controls__trigger {
        display: none;
    }
}
</style>
