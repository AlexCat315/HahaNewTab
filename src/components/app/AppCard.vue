<script setup lang="ts">
/**
 * AppCard - 应用卡片
 *
 * 展示单个应用站点的图标、名称与描述，支持点击打开、编辑与删除操作按钮。
 * 隐藏应用会附加半透明虚线边框样式。所有图标使用 IconSvg，不使用 emoji。
 */
import { computed } from 'vue';
import type { AppItem } from '@/types/app';
import { isImageIcon } from '@/utils/image.util';
import IconSvg from '@/components/icon/IconSvg.vue';
import BaseButton from '@/components/common/BaseButton.vue';

export interface AppCardProps {
    /** 应用数据 */
    app: AppItem;
    /** 是否可拖拽（仅样式标记，实际拖拽由外层 useDragSort 控制） */
    draggable?: boolean;
    /** 是否处于拖拽中 */
    dragging?: boolean;
    /** 是否处于长按按压中 */
    pressing?: boolean;
    /** 是否显示编辑按钮 */
    editable?: boolean;
    /** 是否显示删除按钮 */
    deletable?: boolean;
    /** 是否始终显示操作按钮（默认悬停显示） */
    showActions?: boolean;
    /** 是否显示图标背景（false 时图标背景透明） */
    iconBackground?: boolean;
}

const props = withDefaults(defineProps<AppCardProps>(), {
    draggable: false,
    dragging: false,
    pressing: false,
    editable: true,
    deletable: true,
    showActions: false,
    iconBackground: true,
});

const emit = defineEmits<{
    /** 点击卡片主体（操作按钮区域除外） */
    (e: 'click', app: AppItem): void;
    /** 点击编辑按钮 */
    (e: 'edit', app: AppItem): void;
    /** 点击删除按钮 */
    (e: 'delete', app: AppItem): void;
}>();

const isHidden = computed(() => !!props.app.hidden);

const iconSrc = computed(() => {
    const icon = props.app.icon?.trim();
    if (!icon) {
        return undefined;
    }
    return icon;
});

const iconIsImage = computed(() => isImageIcon(iconSrc.value));

/** 是否已设置图标（未设置时显示默认站点图标，走系统图标遮罩、颜色跟随主题） */
const hasIcon = computed(() => !!iconSrc.value);

function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.app-card__actions')) {
        return;
    }
    emit('click', props.app);
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        emit('click', props.app);
    }
}

function handleEdit(event: MouseEvent): void {
    event.stopPropagation();
    emit('edit', props.app);
}

function handleDelete(event: MouseEvent): void {
    event.stopPropagation();
    emit('delete', props.app);
}
</script>

<template>
    <article
        class="app-card"
        :class="{
            'is-hidden': isHidden,
            'is-dragging': dragging,
            'is-pressing': pressing,
            'is-draggable': draggable,
            'show-actions': showActions,
            'no-icon-bg': !iconBackground,
        }"
        :data-app-id="app.id"
        tabindex="0"
        role="link"
        :aria-label="app.name"
        @click="handleClick"
        @keydown="handleKeydown"
    >
        <div class="app-card__icon">
            <IconSvg
                :src="iconSrc"
                name="site"
                fallback="site"
                size="var(--icon-xl)"
                :monochrome="hasIcon && !iconIsImage"
                :alt="app.name"
            />
        </div>

        <div class="app-card__content">
            <h3 class="app-card__name" :title="app.name">{{ app.name }}</h3>
            <p v-if="app.description" class="app-card__description" :title="app.description">
                {{ app.description }}
            </p>
        </div>

        <div v-if="editable || deletable" class="app-card__actions">
            <BaseButton
                v-if="editable"
                class="app-card__action-btn"
                variant="text"
                size="small"
                :aria-label="`编辑 ${app.name}`"
                @click="handleEdit"
            >
                <template #icon>
                    <IconSvg name="edit" size="var(--icon-xs)" monochrome :alt="`编辑 ${app.name}`" />
                </template>
            </BaseButton>
            <BaseButton
                v-if="deletable"
                class="app-card__action-btn app-card__action-btn--delete"
                variant="text"
                size="small"
                :aria-label="`删除 ${app.name}`"
                @click="handleDelete"
            >
                <template #icon>
                    <IconSvg name="delete" size="var(--icon-xs)" monochrome :alt="`删除 ${app.name}`" />
                </template>
            </BaseButton>
        </div>
    </article>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.app-card {
    // 卡片契约的可点档：bg / border / radius / elevation / padding / hover 抬升
    // 全部由混入给出，这里只补本组件的布局与状态标记
    @include card-interactive;

    position: relative;
    display: flex;
    align-items: center;
    gap: var(--card-gap);
    // 固定等高：容纳两行简介，无简介时内容垂直居中
    height: var(--card-row-height);
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
    contain: layout style paint;
    transform: translateZ(0);

    &.is-hidden {
        opacity: 0.7;
        background: var(--md-sys-color-surface-variant);
        border-style: dashed;
    }

    &.is-dragging {
        opacity: 0.6;
        box-shadow: var(--elevation-3);
        cursor: grabbing;
        z-index: var(--z-dropdown);
        transform: scale(1.02);
    }

    &.is-pressing {
        background: var(--md-sys-color-surface-variant);
    }

    &.is-draggable {
        cursor: grab;
    }

    &.is-dragging,
    &.is-pressing {
        transition: none;
    }

    &__icon {
        width: var(--icon-xl);
        height: var(--icon-xl);
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--md-sys-color-primary-container);
        color: var(--md-sys-color-on-primary-container);
        flex-shrink: 0;
        overflow: hidden;
    }

    // 图标背景关闭时透明
    &.no-icon-bg &__icon {
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
        color: var(--md-sys-color-on-surface);
        line-height: var(--leading-tight);
        @include text-ellipsis;
    }

    &__description {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--md-sys-color-on-surface-variant);
        line-height: var(--leading-normal);
        @include line-clamp(2);
        // 两行的封顶高度由 clamp 的行数推导（2 × leading × 字号），
        // 写死 3em 会在 --leading-* 或 --text-xs 调整后失去同步
        max-height: calc(2 * var(--leading-normal) * var(--text-xs));
    }

    &__actions {
        position: absolute;
        top: var(--space-2);
        right: var(--space-2);
        display: flex;
        align-items: center;
        gap: var(--space-1);
        opacity: 0;
        @include md-transition(opacity, var(--md-transition-fast));
    }

    &:hover &__actions,
    &.show-actions &__actions,
    &:focus-within &__actions {
        opacity: 1;
    }

    &__action-btn {
        width: var(--control-h-xs);
        height: var(--control-h-xs);
        min-width: auto;
        padding: 0 !important;
        border-radius: var(--radius-xs);
        background: var(--hover-bg);
        color: var(--md-sys-color-on-surface-variant);

        &:hover {
            background: var(--tint-primary);
            color: var(--md-sys-color-primary);
        }

        // 删除用「主色底 + error 文字」而不是「error 实底 + 白字」：
        // 深色主题的 error 是浅珊瑚色，白字压上去只有 1.9:1。
        &--delete:hover {
            background: var(--tint-error);
            color: var(--color-error);
        }
    }
}

// 触屏没有 hover，操作按钮不能只靠悬停现身，否则手机端根本改不了站点
@media (hover: none) {
    .app-card__actions {
        opacity: 1;
    }
}

// 深色模式不需要另一套 hover：卡片底色 / 边框都来自主题 token，
// 抬升与描边在明暗两套里都成立
</style>
