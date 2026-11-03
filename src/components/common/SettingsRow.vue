<script setup lang="ts">
/**
 * SettingsRow - 面板里的单条设置行
 *
 * inline：文字在左、控件在右（开关类）
 * stacked：文字在上、控件在下（分段控件、下拉等多行控件）
 */
interface Props {
    /** 控件名称 */
    label?: string;
    /** 名称下方的说明文字 */
    hint?: string;
    /** 排版方向 */
    orientation?: 'inline' | 'stacked';
    /** 控件与文字是否顶部对齐（多行说明时用） */
    alignStart?: boolean;
}

withDefaults(defineProps<Props>(), {
    orientation: 'inline',
});
</script>

<template>
    <div
        class="mnt-settings-row"
        :class="[
            `mnt-settings-row--${orientation}`,
            { 'mnt-settings-row--top': alignStart },
        ]"
    >
        <div v-if="label || $slots.label || hint || $slots.hint" class="mnt-settings-row__text">
            <span v-if="label" class="mnt-settings-row__label">
                <slot name="label">{{ label }}</slot>
            </span>
            <span v-if="hint" class="mnt-settings-row__hint">
                <slot name="hint">{{ hint }}</slot>
            </span>
        </div>
        <div class="mnt-settings-row__control">
            <slot name="control" />
            <slot />
        </div>
    </div>
</template>

<style scoped lang="scss">
.mnt-settings-row {
    gap: var(--space-2);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);

    &:last-child {
        border-bottom: none;
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
        color: var(--md-sys-color-on-surface-variant);
        line-height: var(--leading-normal);
    }

    &__control {
        display: flex;
        align-items: center;
        min-width: 0;
    }

    &--inline {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);

        .mnt-settings-row__text {
            flex: 1;
        }
    }

    &--top {
        align-items: flex-start;
    }

    &--stacked {
        display: flex;
        flex-direction: column;

        .mnt-settings-row__control {
            margin-top: var(--space-2);
        }
    }
}
</style>
