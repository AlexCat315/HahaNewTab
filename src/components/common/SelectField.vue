<script setup lang="ts">
/**
 * SelectField - 下拉选择控件
 *
 * API 与 BaseInput 对齐（label / required / hint / error），这样表单里两类控件
 * 的标签、必填星号、错误文案长得一样，不必每个面板再各写一套原生 select：
 * popup、AppEditModal、UiLibPanel 都曾复制过一份带硬编码 focus 阴影的实现。
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
    /** 校验失败文案；有值时描边转错误色，并取代 hint 显示在控件下方 */
    error?: string;
    /** 覆盖自动生成的控件 id：需要被外部 label 或测试稳定引用时传入 */
    id?: string;
}

const props = withDefaults(defineProps<Props>(), {
    disabled: false,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
}>();

const selectId = computed(() => props.id ?? `mnt-select-${Math.random().toString(36).slice(2, 9)}`);

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
    <div
        class="mnt-select"
        :class="{ 'mnt-select--disabled': disabled, 'mnt-select--error': !!error }"
    >
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

        <div v-if="error || hint" class="mnt-select__messages">
            <p v-if="error" class="mnt-select__error">{{ error }}</p>
            <p v-else-if="hint" class="mnt-select__hint">{{ hint }}</p>
        </div>
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
        color: var(--label);
    }

    &__required {
        color: var(--color-error);
    }

    &__box {
        position: relative;
        display: flex;
        align-items: center;
    }

    // 与 BaseInput 同构：一层灰填充、无描边、圆角矩形，焦点用柔光。
    &__field {
        width: 100%;
        height: var(--control-h-md);
        padding: 0 var(--space-8) 0 var(--space-3);
        border: none;
        border-radius: var(--control-radius);
        background: var(--fill-tertiary);
        color: var(--label);
        font-family: inherit;
        font-size: var(--text-base);
        appearance: none;
        -webkit-appearance: none;
        cursor: pointer;
        @include spring-transition(box-shadow background, var(--dur-fast));
    }

    &__chevron {
        position: absolute;
        right: var(--space-3);
        width: var(--icon-xs);
        height: var(--icon-xs);
        pointer-events: none;
        color: var(--label-secondary);
    }

    &__messages {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
    }

    &__hint {
        margin: 0;
        font-size: var(--text-sm);
        line-height: var(--leading-normal);
        color: var(--label-secondary);
    }

    &__error {
        margin: 0;
        font-size: var(--text-sm);
        line-height: var(--leading-normal);
        color: var(--color-error);
    }

    &:focus-within &__field {
        background: var(--fill-secondary);
        box-shadow: 0 0 0 4px var(--focus-ring);
    }

    &--error &__field {
        box-shadow: 0 0 0 1px var(--color-error);
    }

    &--error &__box:focus-within &__field {
        box-shadow: 0 0 0 4px var(--tint-error);
    }

    &--disabled &__field {
        opacity: 0.55;
        cursor: not-allowed;
    }
}
</style>
