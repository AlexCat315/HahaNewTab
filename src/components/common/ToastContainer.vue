<script setup lang="ts">
import { computed } from 'vue';
import { useToast, type ToastItem, type ToastType } from '@/composables/useToast';

export type ToastPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

interface Props {
    /** Toast 容器位置 */
    position?: ToastPosition;
}

const props = withDefaults(defineProps<Props>(), {
    position: 'top-right',
});

const { toasts, dismiss } = useToast();

const containerClass = computed(() => [
    'mnt-toast-container',
    `mnt-toast-container--${props.position}`,
]);

function getIconPath(type: ToastType): string {
    switch (type) {
        case 'success':
            return 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z';
        case 'error':
            return 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z';
        case 'warning':
            return 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z';
        case 'info':
        default:
            return 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z';
    }
}

function getToastClass(type: ToastType): string {
    return `mnt-toast--${type}`;
}

function handleClose(item: ToastItem): void {
    dismiss(item.id);
}
</script>

<template>
    <Teleport to="body">
        <TransitionGroup
            tag="div"
            name="mnt-toast"
            :class="containerClass"
            role="region"
            aria-live="polite"
            aria-label="通知"
        >
            <div
                v-for="item in toasts"
                :key="item.id"
                class="mnt-toast"
                :class="getToastClass(item.type)"
                role="status"
            >
                <span class="mnt-toast__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path :d="getIconPath(item.type)" /></svg>
                </span>
                <span class="mnt-toast__message" v-html="item.message" />
                <button
                    v-if="item.closable"
                    type="button"
                    class="mnt-toast__close"
                    aria-label="关闭通知"
                    @click="handleClose(item)"
                >
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
                </button>
            </div>
        </TransitionGroup>
    </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-toast-container {
    position: fixed;
    z-index: 3000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    pointer-events: none;
    max-width: 360px;
    width: 100%;

    &--top-right {
        top: 16px;
        right: 16px;
    }

    &--top-left {
        top: 16px;
        left: 16px;
    }

    &--bottom-right {
        bottom: 16px;
        right: 16px;
        flex-direction: column-reverse;
    }

    &--bottom-left {
        bottom: 16px;
        left: 16px;
        flex-direction: column-reverse;
    }
}

.mnt-toast {
    // 类型强调色：success / error / info 跟随主题变量，warning 使用固定琥珀色
    --toast-accent: var(--md-sys-color-primary);

    pointer-events: auto;
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 14px;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.5;
    color: var(--md-sys-color-on-surface);
    // 淡色整条填充：类型强调色低透明度叠加在主题 surface 之上，边框同色稍深
    border: 1px solid rgba(127, 127, 127, 0.35);
    border: 1px solid color-mix(in srgb, var(--toast-accent) 40%, transparent);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    background: rgba(var(--md-sys-color-surface-rgb), 0.88);
    background: color-mix(in srgb, var(--toast-accent) 20%, rgba(var(--md-sys-color-surface-rgb), 0.88));
    backdrop-filter: blur(12px);
    @include md-transition(all, var(--md-transition-fast));

    &__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        color: var(--toast-accent);

        svg {
            width: 20px;
            height: 20px;
            display: block;
        }
    }

    &__message {
        flex: 1;
        min-width: 0;
        word-break: break-word;
    }

    &__close {
        @include button-reset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        color: var(--toast-accent);
        opacity: 0.7;
        flex-shrink: 0;
        @include focus-ring;

        svg {
            width: 16px;
            height: 16px;
            display: block;
        }

        &:hover {
            opacity: 1;
            background: var(--hover-bg);
        }
    }

    &--success {
        --toast-accent: var(--md-sys-color-success);
    }

    &--error {
        --toast-accent: var(--md-sys-color-error);
    }

    &--warning {
        --toast-accent: #F59E0B;
    }

    &--info {
        --toast-accent: var(--md-sys-color-primary);
    }
}

// 进入/离开动画
.mnt-toast-enter-active,
.mnt-toast-leave-active {
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.mnt-toast-enter-from,
.mnt-toast-leave-to {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
}

.mnt-toast-leave-from,
.mnt-toast-enter-to {
    opacity: 1;
    transform: translateY(0) scale(1);
}

@include respond-to(mobile) {
    .mnt-toast-container {
        left: 16px;
        right: 16px;
        max-width: none;
        padding: 12px;

        &--top-right,
        &--top-left {
            top: 12px;
        }

        &--bottom-right,
        &--bottom-left {
            bottom: 12px;
        }
    }
}
</style>
