<script setup lang="ts">
/**
 * SelectField - 下拉选择控件
 *
 * AppEditModal 与 UiLibPanel 曾各自复制过一份带硬编码玫红 focus 阴影的
 * 原生 select，这里合并为一个主题无关的实现。
 */
import { computed } from 'vue';

export interface SelectOption {
    value: string | number;
    label: string;
    disabled?: boolean;
}

interface Props {
    modelValue: string | number | null | undefined;
    options: Array<SelectOption | string | number>;
    label?: string;
    hint?: string;
    /** 空值时显示的占位项文案 */
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    disabled: false,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
}>();

const selectId = computed(() => `mnt-select-${Math.random().toString(36).slice(2, 9)}`);

const normalized = computed<SelectOption[]>(() =>
    props.options.map((option) =>
        typeof option === 'number' || typeof option === 'string'
            ? { value: option, label: String(option) }
            : option
    )
);

function onChange(event: Event): void {
    emit('update:modelValue', (event.target as HTMLSelectElement).value);
}
</script>

<template>
    <div class="mnt-select" :class="{ 'mnt-select--disabled': disabled }">
        <label v-if="label" class="mnt-select__label" :for="selectId">
            {{ label }}
            <span v-if="required" class="mnt-select__required" aria-hidden="true">*</span>
        </label>

        <div class="mnt-select__box">
            <select
                :id="selectId"
                class="mnt-select__field"
                :value="modelValue === null || modelValue === undefined ? '' : String(modelValue)"
                :disabled="disabled"
                :required="required"
                @change="onChange"
            >
                <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
                <option
                    v-for="option in normalized"
                    :key="String(option.value)"
                    :value="String(option.value)"
                    :disabled="option.disabled"
                >
                    {{ option.label }}
                </option>
            </select>
            <svg
                class="mnt-select__chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <path d="M6 9l6 6 6-6" />
            </svg>
        </div>

        <p v-if="hint" class="mnt-select__hint">{{ hint }}</p>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-select {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);

    &__label {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--md-sys-color-on-surface);
    }

    &__required {
        color: var(--md-sys-color-error);
    }

    &__box {
        position: relative;
        display: flex;
        align-items: center;
    }

    &__field {
        width: 100%;
        height: 40px;
        padding: 0 var(--space-8) 0 var(--space-3);
        border: 1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 18%, transparent);
        border-radius: var(--radius-sm);
        background: color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent);
        color: var(--md-sys-color-on-surface);
        font-family: inherit;
        font-size: var(--text-base);
        appearance: none;
        -webkit-appearance: none;
        cursor: pointer;
        @include md-transition(border-color background, var(--md-transition-fast));

        &:hover:not(:disabled) {
            border-color: var(--md-sys-color-primary);
        }
    }

    &__chevron {
        position: absolute;
        right: var(--space-3);
        width: 16px;
        height: 16px;
        pointer-events: none;
        color: var(--md-sys-color-on-surface-variant);
    }

    &__hint {
        margin: 0;
        font-size: var(--text-sm);
        line-height: var(--leading-normal);
        color: var(--md-sys-color-on-surface-variant);
    }

    &--disabled &__field {
        opacity: 0.6;
        cursor: not-allowed;
    }
}
</style>
