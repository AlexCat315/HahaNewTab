<script setup lang="ts">
/**
 * CategoryManager - 分类管理列表
 *
 * 展示用户自定义分类（排除“全部应用”），显示每个分类下的网站数量，
 * 支持新建、编辑与删除。删除前会弹出确认对话框，并直接通过 useDataManager 执行删除。
 */
import { computed, onMounted } from 'vue';
import type { Category } from '@/types/app';
import { useDataManager } from '@/composables/useDataManager';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import ModalOverlay from '@/components/common/ModalOverlay.vue';
import BaseButton from '@/components/common/BaseButton.vue';
import IconSvg from '@/components/icon/IconSvg.vue';

export interface CategoryManagerProps {
    /** 是否显示模态框（支持 v-model） */
    modelValue: boolean;
}

defineProps<CategoryManagerProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'edit', category: Category): void;
    (e: 'add'): void;
    (e: 'close'): void;
}>();

const dataManager = useDataManager({ autoInit: true });
const confirmManager = useConfirm();
const toast = useToast();

onMounted(() => {
    if (!dataManager.initialized.value) {
        dataManager.init().catch((error) => {
            console.error('[CategoryManager] 初始化数据失败:', error);
        });
    }
});

const categories = computed(() => dataManager.userCategories.value);

const appCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const app of dataManager.apps.value) {
        counts[app.category] = (counts[app.category] || 0) + 1;
    }
    return counts;
});

/** 所有用户分类下的网站总数 */
const totalApps = computed(() =>
    categories.value.reduce((sum, category) => sum + (appCounts.value[category.id] || 0), 0)
);

function handleClose(): void {
    emit('update:modelValue', false);
    emit('close');
}

function handleAdd(): void {
    emit('add');
}

function handleEdit(category: Category): void {
    emit('edit', category);
}

async function handleDelete(category: Category): Promise<void> {
    const count = appCounts.value[category.id] || 0;
    const countText = count > 0 ? `该分类下的 ${count} 个网站会归入「全部应用」，不会丢失。` : '';

    const confirmed = await confirmManager.confirm(
        `确定要删除分类"${category.name}"吗？${countText}`,
        { isDanger: true, title: '删除分类' }
    );
    if (!confirmed) return;

    try {
        const deleted = await dataManager.deleteCategory(category.id);
        if (!deleted) {
            throw new Error('无法删除该分类');
        }
        toast.success('分类已删除');
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '删除失败');
    }
}

function formatCount(categoryId: string): string {
    const count = appCounts.value[categoryId] || 0;
    return `${count} 个网站`;
}
</script>

<template>
    <ModalOverlay
        :model-value="modelValue"
        title="管理分类"
        size="md"
        close-on-overlay
        close-on-esc
        @update:model-value="$emit('update:modelValue', $event)"
        @close="handleClose"
    >
        <div class="mnt-category-manager">
            <div
                v-if="categories.length === 0"
                class="mnt-category-manager__empty"
                role="status"
            >
                <IconSvg name="folder" size="var(--icon-2xl)" />
                <p class="mnt-category-manager__empty-title">暂无自定义分类</p>
                <p class="mnt-category-manager__empty-hint">点击下方「新建分类」创建第一个分类</p>
            </div>

            <template v-else>
                <p class="mnt-category-manager__summary">
                    共 {{ categories.length }} 个分类 · {{ totalApps }} 个网站
                </p>

                <ul class="mnt-category-manager__list" role="list">
                    <li
                        v-for="category in categories"
                        :key="category.id"
                        class="mnt-category-manager__item"
                        role="listitem"
                    >
                        <div class="mnt-category-manager__info">
                            <div class="mnt-category-manager__icon">
                                <IconSvg
                                    :src="category.icon"
                                    size="var(--icon-md)"
                                    :monochrome="category.monochrome"
                                    :alt="category.name"
                                />
                            </div>
                            <div class="mnt-category-manager__text">
                                <span class="mnt-category-manager__name">{{ category.name }}</span>
                                <span class="mnt-category-manager__meta">
                                    <span class="mnt-category-manager__count">{{ formatCount(category.id) }}</span>
                                    <span v-if="category.monochrome" class="mnt-category-manager__badge">反色</span>
                                </span>
                            </div>
                        </div>

                        <div class="mnt-category-manager__actions">
                            <BaseButton
                                variant="text"
                                size="small"
                                aria-label="编辑分类"
                                @click="handleEdit(category)"
                            >
                                <template #icon>
                                    <IconSvg name="edit" size="var(--icon-xs)" />
                                </template>
                            </BaseButton>
                            <BaseButton
                                variant="text"
                                size="small"
                                class="mnt-category-manager__delete-btn"
                                aria-label="删除分类"
                                @click="handleDelete(category)"
                            >
                                <template #icon>
                                    <IconSvg name="delete" size="var(--icon-xs)" />
                                </template>
                            </BaseButton>
                        </div>
                    </li>
                </ul>

                <button
                    type="button"
                    class="mnt-category-manager__add-row"
                    @click="handleAdd"
                >
                    <IconSvg name="plus" size="var(--icon-sm)" />
                    <span>新建分类</span>
                </button>
            </template>
        </div>

        <template #footer>
            <BaseButton variant="text" @click="handleClose">关闭</BaseButton>
            <BaseButton variant="primary" @click="handleAdd">
                <template #icon>
                    <IconSvg name="plus" size="var(--icon-xs)" />
                </template>
                新建分类
            </BaseButton>
        </template>
    </ModalOverlay>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-category-manager {
    display: flex;
    flex-direction: column;

    &__summary {
        margin: 0 var(--space-1) var(--space-2);
        font-size: var(--text-xs);
        color: var(--label-secondary);
    }

    &__empty {
        @include flex-center(column, var(--space-3));
        padding: var(--space-8) var(--space-4);
        color: var(--label-secondary);
        text-align: center;

        p {
            margin: 0;
            font-size: var(--text-base);
        }
    }

    &__empty-title {
        font-weight: var(--weight-semibold);
        color: var(--label);
    }

    &__empty-hint {
        font-size: var(--text-xs) !important;
        opacity: 0.8;
    }

    &__list {
        list-style: none;
        margin: 0;
        padding: var(--space-1);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        max-height: 400px;
        @include scrollable;
    }

    &__item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        background: var(--fill);
        border: 1px solid var(--separator);
        @include spring-transition(all, var(--dur-fast));

        &:hover {
            background: var(--fill-tertiary);
            transform: scale(1.02);
            box-shadow: var(--elevation-1);
        }
    }

    &__info {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex: 1;
        min-width: 0;
    }

    &__icon {
        width: var(--icon-xl);
        height: var(--icon-xl);
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        background: var(--tint-primary);
        color: var(--on-tint);
        border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
        overflow: hidden;
    }

    &__text {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
    }

    &__name {
        font-weight: var(--weight-semibold);
        font-size: var(--text-md);
        color: var(--label);
        line-height: var(--leading-tight);
        @include text-ellipsis;
    }

    &__meta {
        display: flex;
        align-items: center;
        gap: var(--space-1);
    }

    &__count {
        font-size: var(--text-xs);
        color: var(--label-secondary);
        line-height: var(--leading-tight);
    }

    &__badge {
        font-size: var(--text-xs);
        line-height: var(--leading-tight);
        padding: 0 var(--space-1);
        border-radius: var(--radius-full);
        background: var(--tint-primary);
        color: var(--accent);
    }

    &__actions {
        display: flex;
        gap: var(--space-1);
        flex-shrink: 0;
    }

    &__delete-btn {
        color: var(--color-error);

        // 「tint 底 + error 文字」：深色主题的 error 是浅珊瑚色，实底压白字读不出
        &:hover {
            background: var(--tint-error);
        }
    }

    &__add-row {
        @include button-reset;
        margin-top: var(--space-2);
        width: 100%;
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        border: 1.5px dashed var(--separator);
        color: var(--label-secondary);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        @include flex-center(row, var(--space-2));
        @include spring-transition(all, var(--dur-fast));

        &:hover {
            border-color: var(--label-tertiary);
            color: var(--label);
            background: var(--fill-tertiary);
        }
    }
}
</style>
