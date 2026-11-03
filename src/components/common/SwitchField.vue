<script setup lang="ts">
/**
 * SwitchField - 开关控件
 *
 * 替代项目里 4 种各写一遍的 `<input type="checkbox">`：
 * 保留原生 checkbox 的可访问性与键盘行为，只把外观换成 M3 开关。
 */
import { computed } from 'vue';

interface Props {
    modelValue: boolean;
    /** 开关名称，留空时由外层 SettingsRow 提供 */
    label?: string;
    /** 名称下方的说明 */
    hint?: string;
    disabled?: boolean;
}

withDefaults(defineProps<Props>(), {
    disabled: false,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
}>();

const inputId = computed(() => `mnt-switch-${Math.random().toString(36).slice(2, 9)}`);

function onChange(event: Event): void {
    emit('update:modelValue', (event.target as HTMLInputElement).checked);
}
</script>

<template>
    <label
        class="mnt-switch"
        :class="{
            'mnt-switch--on': modelValue,
            'mnt-switch--disabled': disabled,
            'mnt-switch--bare': !label && !hint,
        }"
        :for="inputId"
    >
        <span v-if="label || hint" class="mnt-switch__text">
            <span class="mnt-switch__label">{{ label }}</span>
            <span v-if="hint" class="mnt-switch__hint">{{ hint }}</span>
        </span>
        <input
            :id="inputId"
            class="mnt-switch__input"
            type="checkbox"
            role="switch"
            :checked="modelValue"
            :disabled="disabled"
            @change="onChange"
        />
        <span class="mnt-switch__track" aria-hidden="true">
            <span class="mnt-switch__thumb" />
        </span>
    </label>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    cursor: pointer;

    &--bare {
        justify-content: flex-end;
    }

    &__text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    &__label {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--md-sys-color-on-surface);
        line-height: var(--leading-normal);
    }

    &__hint {
        font-size: var(--text-sm);
        font-weight: var(--weight-regular);
        color: var(--md-sys-color-on-surface-variant);
        line-height: var(--leading-normal);
    }

    // 原生 checkbox 只保留语义，不占位
    &__input {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    &__track {
        position: relative;
        flex-shrink: 0;
        width: 40px;
        height: 22px;
        border-radius: var(--radius-full);
        background: var(--md-sys-color-surface-variant);
        border: 2px solid var(--md-sys-color-outline);
        @include md-transition(background border-color, var(--md-transition-fast));
    }

    &__thumb {
        position: absolute;
        top: 50%;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--md-sys-color-outline);
        transform: translate(0, -50%);
        @include md-transition(all, var(--md-transition-fast));
    }

    &--on &__track {
        background: var(--md-sys-color-primary);
        border-color: var(--md-sys-color-primary);
    }

    &--on &__thumb {
        background: var(--md-sys-color-on-primary);
        transform: translate(18px, -50%);
    }

    &__input:focus-visible + &__track {
        outline: var(--focus-ring-width) solid var(--focus-ring);
        outline-offset: var(--focus-ring-offset);
    }

    &--disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }
}
</style>
