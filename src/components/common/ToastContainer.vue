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
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    pointer-events: none;
    max-width: var(--pop-w-toast);
    width: 100%;

    &--top-right {
        top: var(--space-4);
        right: var(--space-4);
    }

    &--top-left {
        top: var(--space-4);
        left: var(--space-4);
    }

    &--bottom-right {
        bottom: var(--space-4);
        right: var(--space-4);
        flex-direction: column-reverse;
    }

    &--bottom-left {
        bottom: var(--space-4);
        left: var(--space-4);
        flex-direction: column-reverse;
    }
}

.mnt-toast {
    // 类型强调色只染图标，不染整条：Apple 的通知是「一块干净的材质 + 一个彩色符号」，
    // 整条描边 + 整条彩色底是 Material 的 snackbar。底色仍走材质档，所以切主题照跟。
    --toast-accent: var(--accent);

    pointer-events: auto;
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-normal);
    color: var(--label);
    border: 1px solid var(--separator);
    box-shadow: var(--elevation-3);
    background: var(--glass-bg-opaque);
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    @include spring-transition(all, var(--dur-fast));

    &__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: var(--icon-sm);
        height: var(--icon-sm);
        color: var(--toast-accent);

        svg {
            width: var(--icon-sm);
            height: var(--icon-sm);
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
        border-radius: var(--radius-xs);
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
        --toast-accent: var(--color-success);
    }

    &--error {
        --toast-accent: var(--color-error);
    }

    &--warning {
        --toast-accent: var(--color-warning);
    }

    &--info {
        --toast-accent: var(--accent);
    }
}

// 进入/离开动画
.mnt-toast-enter-active,
.mnt-toast-leave-active {
    transition: all var(--dur-med) var(--ease-spring);
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
        left: var(--space-4);
        right: var(--space-4);
        max-width: none;
        padding: var(--space-3);

        &--top-right,
        &--top-left {
            top: var(--space-3);
        }

        &--bottom-right,
        &--bottom-left {
            bottom: var(--space-3);
        }
    }
}
</style>
