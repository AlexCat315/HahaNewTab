<script setup lang="ts">
import { computed } from 'vue';

export type InputType = 'text' | 'password' | 'email' | 'url' | 'search' | 'number' | 'tel';

interface Props {
    /** 输入值（支持 v-model） */
    modelValue?: string | number;
    /** 输入框标签 */
    label?: string;
    /** 占位符 */
    placeholder?: string;
    /** 原生 input type */
    type?: InputType;
    /** 是否必填 */
    required?: boolean;
    /** 是否禁用 */
    disabled?: boolean;
    /** 是否只读 */
    readonly?: boolean;
    /** 错误提示文本 */
    error?: string;
    /** 辅助提示文本 */
    hint?: string;
    /** 原生 input id */
    id?: string;
    /** 原生 name */
    name?: string;
    /** 原生 autocomplete */
    autocomplete?: string;
}

const props = withDefaults(defineProps<Props>(), {
    type: 'text',
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'blur', event: FocusEvent): void;
    (e: 'focus', event: FocusEvent): void;
    (e: 'keydown', event: KeyboardEvent): void;
    (e: 'enter', value: string): void;
}>();

const inputId = computed(() => props.id || `mnt-input-${Math.random().toString(36).slice(2, 9)}`);

function handleInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    emit('update:modelValue', target.value);
}

function handleKeydown(event: KeyboardEvent): void {
    emit('keydown', event);
    if (event.key === 'Enter') {
        emit('enter', String(props.modelValue ?? ''));
    }
}

function handleBlur(event: FocusEvent): void {
    emit('blur', event);
}

function handleFocus(event: FocusEvent): void {
    emit('focus', event);
}
</script>

<template>
    <div class="mnt-base-input" :class="{ 'mnt-base-input--error': !!error, 'mnt-base-input--disabled': disabled }">
        <label v-if="label" :for="inputId" class="mnt-base-input__label">
            {{ label }}
            <span v-if="required" class="mnt-base-input__required" aria-hidden="true">*</span>
        </label>

        <div class="mnt-base-input__wrapper">
            <div v-if="$slots.prefix" class="mnt-base-input__prefix">
                <slot name="prefix" />
            </div>

            <input
                :id="inputId"
                class="mnt-base-input__field"
                :class="{ 'mnt-base-input__field--has-prefix': $slots.prefix, 'mnt-base-input__field--has-suffix': $slots.suffix }"
                :type="type"
                :value="modelValue"
                :placeholder="placeholder"
                :required="required"
                :disabled="disabled"
                :readonly="readonly"
                :name="name"
                :autocomplete="autocomplete"
                @input="handleInput"
                @blur="handleBlur"
                @focus="handleFocus"
                @keydown="handleKeydown"
            />

            <div v-if="$slots.suffix" class="mnt-base-input__suffix">
                <slot name="suffix" />
            </div>
        </div>

        <div v-if="error || hint" class="mnt-base-input__messages">
            <p v-if="error" class="mnt-base-input__error">{{ error }}</p>
            <p v-else-if="hint" class="mnt-base-input__hint">{{ hint }}</p>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-base-input {
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

    // 高度取 --control-h-md 而不是靠上下 padding 撑：与同排的单选项
    // （BaseButton medium、SelectField、SwitchField 行）严格等高。
    // Apple 的输入框是「一层灰填充 + 无描边」，靠焦点光晕而不是描边变色表达焦点——
    // 描边一圈主色是 Material 的写法，在一列字段里会显得每格都在喊。
    &__wrapper {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        width: 100%;
        height: var(--control-h-md);
        padding: 0 var(--space-3);
        border: none;
        border-radius: var(--control-radius);
        background: var(--fill-tertiary);
        color: var(--label);
        @include spring-transition(box-shadow background, var(--dur-fast));
    }

    &__field {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        color: inherit;
        font-size: var(--text-base);
        font-family: inherit;
        outline: none;

        &::placeholder {
            color: var(--label-tertiary);
        }

        // type=search 的原生清除按钮由 UA 绘制，永远是系统蓝，换任何一套主题都不跟随。
        // appearance 掉它再用 currentColor 重画一个：点击行为仍是原生清空。
        &::-webkit-search-cancel-button {
            -webkit-appearance: none;
            appearance: none;
            width: var(--icon-xs);
            height: var(--icon-xs);
            margin-left: var(--space-1);
            cursor: pointer;
            background-color: currentColor;
            opacity: 0.7;
            -webkit-mask: var(--clear-mask) center / contain no-repeat;
            mask: var(--clear-mask) center / contain no-repeat;
        }

        &--has-prefix {
            padding-left: var(--space-1);
        }

        &--has-suffix {
            padding-right: var(--space-1);
        }
    }

    &__prefix,
    &__suffix {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--label-secondary);
    }

    &__messages {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
    }

    &__hint,
    &__error {
        margin: 0;
        font-size: var(--text-sm);
        line-height: var(--leading-normal);
    }

    &__hint {
        color: var(--label-secondary);
        opacity: 0.85;
    }

    &__error {
        color: var(--color-error);
    }

    // 焦点：一圈由强调色派生的柔光（--focus-ring 已混过 alpha），不换描边。
    // 写死主色阴影在薄荷绿/午夜蔷薇等主题下会跑色，所以始终从 token 现混。
    &:focus-within &__wrapper {
        background: var(--fill-secondary);
        box-shadow: 0 0 0 4px var(--focus-ring);
    }

    &--error &__wrapper {
        box-shadow: 0 0 0 1px var(--color-error);
    }

    &--error:focus-within &__wrapper {
        box-shadow: 0 0 0 4px var(--tint-error);
    }

    &--disabled &__wrapper {
        background: var(--fill-tertiary);
        opacity: 0.55;
        cursor: not-allowed;
    }
}
</style>
