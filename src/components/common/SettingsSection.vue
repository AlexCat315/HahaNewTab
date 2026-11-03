<script setup lang="ts">
/**
 * SettingsSection - 面板内的分组容器
 *
 * 统一「分组标题 + 说明 + 内容」的排版，避免每个设置页各写一套 header/hint。
 */
interface Props {
    /** 分组标题 */
    title?: string;
    /** 标题右侧的补充说明 */
    description?: string;
}

defineProps<Props>();
</script>

<template>
    <section class="mnt-settings-section">
        <header v-if="title || $slots.actions || description" class="mnt-settings-section__header">
            <div class="mnt-settings-section__heading">
                <h4 v-if="title" class="mnt-settings-section__title">{{ title }}</h4>
                <p v-if="description" class="mnt-settings-section__desc">{{ description }}</p>
            </div>
            <div v-if="$slots.actions" class="mnt-settings-section__actions">
                <slot name="actions" />
            </div>
        </header>
        <div class="mnt-settings-section__body">
            <slot />
        </div>
    </section>
</template>

<style scoped lang="scss">
.mnt-settings-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);

    &__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
        padding-bottom: var(--space-2);
    }

    &__heading {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    &__title {
        margin: 0;
        font-size: var(--text-xs);
        font-weight: var(--weight-semibold);
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: var(--md-sys-color-on-surface-variant);
        line-height: var(--leading-tight);
    }

    &__desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--md-sys-color-on-surface-variant);
        line-height: var(--leading-normal);
    }

    &__actions {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: var(--space-2);
    }

    &__body {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
    }
}
</style>
