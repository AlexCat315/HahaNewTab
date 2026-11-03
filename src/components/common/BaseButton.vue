<script setup lang="ts">
export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger' | 'outlined';
export type ButtonSize = 'small' | 'medium' | 'large';

interface Props {
    /** 按钮样式变体 */
    variant?: ButtonVariant;
    /** 按钮尺寸 */
    size?: ButtonSize;
    /** 原生 button type */
    type?: 'button' | 'submit' | 'reset';
    /** 是否禁用 */
    disabled?: boolean;
    /** 是否显示加载状态 */
    loading?: boolean;
    /** 是否块级宽度 */
    block?: boolean;
    /** 原生 aria-label */
    ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
    variant: 'primary',
    size: 'medium',
    type: 'button',
});

const emit = defineEmits<{
    (e: 'click', event: MouseEvent): void;
}>();

function handleClick(event: MouseEvent): void {
    if (props.disabled || props.loading) return;
    emit('click', event);
}

const spinnerPath = 'M12 2v4m0 12v4M2 12h4m12 0h4';
</script>

<template>
    <button
        class="mnt-base-button"
        :class="[
            `mnt-base-button--${variant}`,
            `mnt-base-button--${size}`,
            { 'mnt-base-button--block': block, 'mnt-base-button--loading': loading, 'mnt-base-button--disabled': disabled },
        ]"
        :type="type"
        :disabled="disabled || loading"
        :aria-label="ariaLabel"
        :aria-busy="loading"
        @click="handleClick"
    >
        <span v-if="loading" class="mnt-base-button__spinner" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path :d="spinnerPath" />
            </svg>
        </span>
        <span v-if="$slots.icon && !loading" class="mnt-base-button__icon" aria-hidden="true">
            <slot name="icon" />
        </span>
        <span v-if="$slots.default" class="mnt-base-button__content">
            <slot />
        </span>
    </button>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-base-button {
    @include button-reset;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border-radius: var(--radius-full);
    font-weight: var(--weight-semibold);
    line-height: 1;
    white-space: nowrap;
    @include md-transition(all, var(--md-transition-fast));

    // 尺寸用 height + 横向 padding 定义，不再靠上下 padding 撑：
    // 同一排按钮里有单行文字也有图标时，垂直 padding 会让它们视觉不等高。
    &--small {
        height: 30px;
        padding: 0 var(--space-3);
        font-size: var(--text-sm);
    }

    &--medium {
        height: 38px;
        padding: 0 var(--space-5);
        font-size: var(--text-base);
    }

    &--large {
        height: 46px;
        padding: 0 var(--space-6);
        font-size: var(--text-md);
    }

    &--block {
        width: 100%;
    }

    &--primary {
        background: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary);

        &:not(:disabled):hover {
            transform: translateY(-1px);
            // 混 12% 到 on-primary：浅色主题变亮、深色主题变暗，两种都成立，
            // 不必像以前那样写死一个玫瑰色投影（换个主题就穿帮）
            background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
            box-shadow: var(--elevation-2);
        }
    }

    &--secondary {
        background: var(--md-sys-color-surface-variant);
        color: var(--md-sys-color-on-surface);
        border: 1px solid var(--card-border);

        &:not(:disabled):hover {
            background: var(--hover-bg);
            border-color: var(--md-sys-color-primary);
        }
    }

    &--outlined {
        background: transparent;
        color: var(--md-sys-color-primary);
        border: 1px solid var(--card-border);

        &:not(:disabled):hover {
            background: var(--md-sys-color-primary-container);
            color: var(--md-sys-color-on-primary-container);
            border-color: var(--md-sys-color-primary);
        }
    }

    &--text {
        background: transparent;
        color: var(--md-sys-color-on-surface-variant);

        &:not(:disabled):hover {
            color: var(--md-sys-color-on-surface);
            background: var(--hover-bg);
        }
    }

    // 危险操作用「error 淡底 + error 文字」，不是「error 实底 + 白字」：
    // 深色主题的 error 是浅珊瑚色，白字压上去只有 1.9:1，
    // 而且主题 token 里根本没有 on-error 这个色，写死的 #fff 无法跟随主题。
    &--danger {
        background: color-mix(in srgb, var(--md-sys-color-error) 14%, transparent);
        color: var(--md-sys-color-error);

        &:not(:disabled):hover {
            background: color-mix(in srgb, var(--md-sys-color-error) 24%, transparent);
        }
    }

    &--disabled,
    &--loading,
    &:disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    &__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex-shrink: 0;

        :deep(svg) {
            width: 100%;
            height: 100%;
        }
    }

    &__spinner {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        animation: mnt-spin 1s linear infinite;

        svg {
            width: 100%;
            height: 100%;
        }
    }
}

@keyframes mnt-spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}
</style>
