<script setup lang="ts">
import { computed } from 'vue';

interface Props {
    /** 当前值（支持 v-model） */
    modelValue: number;
    /** 滑块标签 */
    label?: string;
    /** 最小值 */
    min?: number;
    /** 最大值 */
    max?: number;
    /** 步长 */
    step?: number;
    /** 是否显示当前数值 */
    showValue?: boolean;
    /** 数值格式化函数 */
    formatValue?: (value: number) => string;
    /** 是否禁用 */
    disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    min: 0,
    max: 100,
    step: 1,
    showValue: true,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: number): void;
    /** 拖动结束（或键盘调节完成）时触发，用于一次性持久化，避免拖动中连续写存储 */
    (e: 'change', value: number): void;
}>();

const displayValue = computed(() => {
    if (props.formatValue) {
        return props.formatValue(props.modelValue);
    }
    return String(props.modelValue);
});

const progressPercent = computed(() => {
    const range = props.max - props.min;
    if (range === 0) return 0;
    return ((props.modelValue - props.min) / range) * 100;
});

function handleInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    emit('update:modelValue', Number(target.value));
}

function handleChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    emit('change', Number(target.value));
}

function clampValue(value: number): number {
    return Math.min(props.max, Math.max(props.min, value));
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft') {
        return;
    }
    event.preventDefault();
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1;
    const nextValue = clampValue(props.modelValue + props.step * direction);
    emit('update:modelValue', nextValue);
}
</script>

<template>
    <div class="mnt-base-slider" :class="{ 'mnt-base-slider--disabled': disabled }">
        <label v-if="label || showValue" class="mnt-base-slider__label">
            <span v-if="label" class="mnt-base-slider__label-text">{{ label }}</span>
            <span v-if="showValue" class="mnt-base-slider__value">{{ displayValue }}</span>
        </label>

        <div class="mnt-base-slider__track">
            <input
                type="range"
                class="mnt-base-slider__input"
                :min="min"
                :max="max"
                :step="step"
                :value="modelValue"
                :disabled="disabled"
                @input="handleInput"
                @change="handleChange"
                @keydown="handleKeydown"
            />
            <div class="mnt-base-slider__progress" :style="{ width: `${progressPercent}%` }" />
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-base-slider {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);

    &__label {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--md-sys-color-on-surface-variant);
        font-weight: var(--weight-medium);
        line-height: var(--leading-normal);
    }

    &__value {
        color: var(--md-sys-color-primary);
        font-weight: var(--weight-semibold);
        font-variant-numeric: tabular-nums;
    }

    &__track {
        position: relative;
        width: 100%;
        height: var(--control-h-sm);
        display: flex;
        align-items: center;
    }

    &__progress {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        height: 4px;
        border-radius: var(--radius-full);
        background: var(--md-sys-color-primary);
        pointer-events: none;
    }

    &__input {
        position: relative;
        z-index: var(--z-content);
        width: 100%;
        height: var(--control-h-sm);
        border-radius: var(--radius-full);
        background: transparent;
        outline: none;
        -webkit-appearance: none;
        appearance: none;
        cursor: pointer;

        // 热区吃满控件档，视觉轨道仍是一条居中 4px 线：以前 input 本体只有
        // 4px 高，触屏/精确指针下几乎点不中。
        &::-webkit-slider-runnable-track {
            height: var(--control-h-sm);
            border-radius: var(--radius-full);
            background: linear-gradient(
                var(--md-sys-color-surface-variant),
                var(--md-sys-color-surface-variant)
            ) center / 100% 4px no-repeat;
        }

        &::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: var(--icon-xs);
            height: var(--icon-xs);
            // Blink 不自动垂直居中滑块，需按 (轨道高 - 滑块高)/2 下推
            margin-top: calc((var(--control-h-sm) - var(--icon-xs)) / 2);
            border-radius: var(--radius-full);
            background: var(--md-sys-color-primary);
            cursor: pointer;
            box-shadow: var(--elevation-1);
            @include md-transition(transform, var(--md-transition-fast));
        }

        &::-moz-range-track {
            width: 100%;
            height: var(--control-h-sm);
            border-radius: var(--radius-full);
            background: linear-gradient(
                var(--md-sys-color-surface-variant),
                var(--md-sys-color-surface-variant)
            ) center / 100% 4px no-repeat;
        }

        &::-moz-range-thumb {
            width: var(--icon-xs);
            height: var(--icon-xs);
            border: none;
            border-radius: var(--radius-full);
            background: var(--md-sys-color-primary);
            cursor: pointer;
            box-shadow: var(--elevation-1);
            @include md-transition(transform, var(--md-transition-fast));
        }

        &::-webkit-slider-thumb:hover,
        &::-moz-range-thumb:hover {
            transform: scale(1.15);
        }
    }

    &--disabled {
        opacity: 0.5;

        .mnt-base-slider__input {
            cursor: not-allowed;
        }
    }
}
</style>
