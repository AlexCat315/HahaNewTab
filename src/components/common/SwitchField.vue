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
    // 开关行与同排的按钮 / 下拉 / 输入框取同一档热区高度；
    // track 本身是 M3 几何（40×22），撑高的是可点的整行标签
    min-height: var(--control-h-md);
    cursor: pointer;

    &--bare {
        justify-content: flex-end;
    }

    &__text {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
    }

    &__label {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--label);
        line-height: var(--leading-normal);
    }

    &__hint {
        font-size: var(--text-sm);
        font-weight: var(--weight-regular);
        color: var(--label-secondary);
        line-height: var(--leading-normal);
    }

    // 原生 checkbox 只保留语义，不占位
    &__input {
        @include visually-hidden;
    }

    // iOS 开关：胶囊轨道 + 带阴影的白圆点，靠轨道换色而不是加描边。
    // 以前那圈 2px 描边是 Material 的「未选中要有边界」，Apple 的关态是一层灰填充。
    &__track {
        position: relative;
        flex-shrink: 0;
        width: 44px;
        height: 26px;
        border-radius: var(--radius-full);
        background: var(--fill);
        @include spring-transition(background, var(--dur-med));
    }

    &__thumb {
        position: absolute;
        top: 50%;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: var(--radius-full);
        background: var(--material-thick);
        box-shadow: var(--elevation-1);
        transform: translate(0, -50%);
        @include spring-transition(all, var(--dur-med));
    }

    &--on &__track {
        background: var(--accent);
    }

    &--on &__thumb {
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
