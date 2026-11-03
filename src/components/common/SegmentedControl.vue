<script setup lang="ts">
/**
 * SegmentedControl - 分段选择控件
 *
 * 项目里原本有 3 套各写一遍的分段按钮（页面布局 / 云同步 / 主题模式），
 * 这里合并为一个：同一套高度、圆角、选中态与键盘行为。
 */
import { computed } from 'vue';

export interface SegmentedOption {
    value: string | number | boolean;
    label: string;
}

interface Props {
    modelValue: string | number | boolean;
    /** 直接传值数组，或 { value, label } 数组 */
    options: Array<SegmentedOption | string | number>;
    /** 无障碍分组名称 */
    ariaLabel?: string;
    /** 等分填满容器宽度 */
    block?: boolean;
    disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    block: false,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string | number | boolean): void;
}>();

const normalized = computed<SegmentedOption[]>(() =>
    props.options.map((option) =>
        typeof option === 'number' || typeof option === 'string'
            ? { value: option, label: String(option) }
            : option
    )
);

function select(option: SegmentedOption): void {
    if (props.disabled || option.value === props.modelValue) return;
    emit('update:modelValue', option.value);
}

/** 方向键在分段之间移动焦点并直接选中，避免每段都要按一次 Tab */
function moveFocus(event: KeyboardEvent, index: number, delta: number): void {
    const container = (event.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.mnt-segmented__item'));
    if (buttons.length === 0) return;
    const next = (index + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
    select(normalized.value[next]);
}
</script>

<template>
    <div
        class="mnt-segmented"
        :class="{ 'mnt-segmented--block': block }"
        role="group"
        :aria-label="ariaLabel"
        :aria-disabled="disabled"
    >
        <button
            v-for="(option, index) in normalized"
            :key="String(option.value)"
            type="button"
            class="mnt-segmented__item"
            :class="{ 'mnt-segmented__item--active': option.value === modelValue }"
            :aria-pressed="option.value === modelValue"
            :disabled="disabled"
            @click="select(option)"
            @keydown.left.prevent="moveFocus($event, index, -1)"
            @keydown.right.prevent="moveFocus($event, index, 1)"
        >
            {{ option.label }}
        </button>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-segmented {
    display: inline-flex;
    gap: var(--space-1);
    padding: 3px;
    border-radius: var(--radius-md);
    background: var(--md-sys-color-surface-variant);
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
        display: none;
    }

    &--block {
        display: flex;
        width: 100%;
    }

    &__item {
        @include button-reset;
        @include flex-center(row, 0);
        flex: 1 0 auto;
        height: 30px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--md-sys-color-on-surface-variant);
        white-space: nowrap;
        @include md-transition(color background, var(--md-transition-fast));

        &:hover:not(:disabled) {
            color: var(--md-sys-color-on-surface);
            background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
        }

        &--active,
        &--active:hover:not(:disabled) {
            background: var(--md-sys-color-primary);
            color: var(--md-sys-color-on-primary);
        }

        &:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
    }
}
</style>
