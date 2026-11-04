<script setup lang="ts">
/**
 * AppCardDragGhost - 卡片拖拽幽灵
 *
 * 拖拽期间渲染在 body 下的浮动卡片，以指针为中心跟随移动，
 * 视觉复刻 AppCard（图标 + 名称 + 描述），自身不响应任何指针事件。
 */
import { computed } from 'vue';
import { useAppCardDrag } from '@/composables/useAppCardDrag';
import { useLayoutStore } from '@/stores/layout.store';
import { isImageIcon } from '@/utils/image.util';
import IconSvg from '@/components/icon/IconSvg.vue';

const cardDrag = useAppCardDrag();
const layoutStore = useLayoutStore();
const state = cardDrag.state;

const visible = computed(() => state.phase === 'dragging' && !!state.app);

const iconSrc = computed(() => state.app?.icon?.trim() || undefined);
const iconIsImage = computed(() => isImageIcon(iconSrc.value));
const ghostStyle = computed(() => ({
    left: `${state.ghostX - state.cardWidth / 2}px`,
    top: `${state.ghostY - state.cardHeight / 2}px`,
    width: `${state.cardWidth}px`,
    minHeight: `${state.cardHeight}px`,
}));
</script>

<template>
    <Teleport to="body">
        <div
            v-if="visible"
            class="app-card-drag-ghost"
            :class="{ 'app-card-drag-ghost--no-icon-bg': !layoutStore.showIconBackground }"
            :style="ghostStyle"
            aria-hidden="true"
        >
            <div class="app-card-drag-ghost__icon">
                <IconSvg
                    :src="iconSrc"
                    name="site"
                    fallback="site"
                    size="var(--icon-xl)"
                    :monochrome="!!iconSrc && !iconIsImage"
                    :alt="state.app?.name"
                />
            </div>
            <div class="app-card-drag-ghost__content">
                <h3 class="app-card-drag-ghost__name">{{ state.app?.name }}</h3>
                <p v-if="state.app?.description" class="app-card-drag-ghost__description">
                    {{ state.app.description }}
                </p>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.app-card-drag-ghost {
    // 幽灵卡片复刻 AppCard 的表面（bg / 描边宽度 / 圆角 / padding 走卡片契约），
    // 只把描边换成主色、投影抬到 elevation-3，让它读起来是「被拿起来的那一张」
    @include card;

    position: fixed;
    z-index: var(--z-drag-ghost);
    display: flex;
    align-items: center;
    gap: var(--card-gap);
    // 与 AppCard 同一几何契约：inline 的 minHeight 是实测卡高，
    // 这里补 token 高，保证拿起的瞬间不会先塌回内容高再被撑开
    height: var(--card-row-height);
    border-color: var(--accent);
    box-shadow: var(--elevation-3);
    pointer-events: none;
    transform: scale(1.03);

    &__icon {
        width: var(--icon-xl);
        height: var(--icon-xl);
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--tint-primary);
        color: var(--on-tint);
        flex-shrink: 0;
        overflow: hidden;
    }

    // 图标背景关闭时透明
    &--no-icon-bg &__icon {
        background: transparent;
    }

    &__content {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
    }

    &__name {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--weight-semibold);
        line-height: var(--leading-tight);
        color: var(--label);
        @include text-ellipsis;
    }

    &__description {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--label-secondary);
        opacity: 0.85;
        line-height: var(--leading-normal);
        @include line-clamp(2);
        max-height: calc(2 * var(--leading-normal) * var(--text-xs));
    }
}
</style>
