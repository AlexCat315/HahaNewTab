<script setup lang="ts">
/**
 * CategorySection - 分类区块
 *
 * 一行分类页头（图标 + 名称 + 站点数 + 内联添加操作）与该分类下的应用网格。
 * 页头把「这个分类有几个站点」和「往这个分类加站点」放在一起，
 * 用户不必先点进分类再找添加按钮。
 * 所有事件向上透传，自身不持有业务状态。
 */
import { computed } from 'vue';
import type { AppItem, Category } from '@/types/app';
import { isImageIcon } from '@/utils/image.util';
import AppGrid from './AppGrid.vue';
import IconSvg from '@/components/icon/IconSvg.vue';

export interface CategorySectionProps {
    /** 分类数据 */
    category: Category;
    /** 该分类下的应用列表 */
    apps: AppItem[];
    /** 是否显示分类标题 */
    showTitle?: boolean;
    /** 是否启用拖拽排序 */
    draggable?: boolean;
    /** 是否显示隐藏应用（已过滤传入时此属性仅影响空状态） */
    showHidden?: boolean;
    /** 是否显示编辑按钮 */
    editable?: boolean;
    /** 是否显示删除按钮 */
    deletable?: boolean;
    /** 是否在页头显示「添加网站」 */
    showAdd?: boolean;
    /** 入场动画延迟（秒） */
    animationDelay?: number;
}

const props = withDefaults(defineProps<CategorySectionProps>(), {
    showTitle: true,
    draggable: false,
    showHidden: false,
    editable: true,
    deletable: true,
    showAdd: false,
    animationDelay: 0,
});

const emit = defineEmits<{
    /** 点击应用卡片 */
    (e: 'app-click', app: AppItem): void;
    /** 点击编辑按钮 */
    (e: 'edit-app', app: AppItem): void;
    /** 点击删除按钮 */
    (e: 'delete-app', app: AppItem): void;
    /** 点击页头的「添加网站」 */
    (e: 'add-app', categoryId: string): void;
}>();

const iconIsImage = computed(() => isImageIcon(props.category.icon?.trim() || 'folder'));

function handleAppClick(app: AppItem): void {
    emit('app-click', app);
}

function handleEdit(app: AppItem): void {
    emit('edit-app', app);
}

function handleDelete(app: AppItem): void {
    emit('delete-app', app);
}

function handleAdd(): void {
    emit('add-app', props.category.id);
}
</script>

<template>
    <section
        class="category-section"
        :style="animationDelay > 0 ? { animationDelay: `${animationDelay}s` } : undefined"
    >
        <header v-if="showTitle" class="category-section__head">
            <h3 class="category-section__title">
                <span class="category-section__icon">
                    <IconSvg
                        :src="category.icon"
                        name="folder"
                        size="var(--icon-xs)"
                        :monochrome="category.monochrome && !iconIsImage"
                        :alt="category.name"
                    />
                </span>
                <span class="category-section__name">{{ category.name }}</span>
            </h3>
            <span class="category-section__count">{{ apps.length }} 个站点</span>

            <button
                v-if="showAdd"
                type="button"
                class="category-section__add"
                :title="`添加网站到${category.name}`"
                @click="handleAdd"
            >
                <IconSvg name="plus" size="var(--icon-xs)" monochrome alt="" />
                <span>添加</span>
            </button>
        </header>

        <AppGrid
            :apps="apps"
            :category-id="category.id"
            :draggable="draggable"
            :show-hidden="showHidden"
            :editable="editable"
            :deletable="deletable"
            @app-click="handleAppClick"
            @edit-app="handleEdit"
            @delete-app="handleDelete"
        >
            <template v-if="$slots.empty" #empty>
                <slot name="empty" />
            </template>
        </AppGrid>
    </section>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.category-section {
    margin-bottom: var(--space-8);
    animation: fadeInUp 0.5s ease-out both;
    contain: layout;

    @keyframes fadeInUp {
        from {
            opacity: 0;
            transform: translateY(var(--space-4));
        }

        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    &__head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: var(--space-3);
    }

    &__title {
        font-size: var(--text-md);
        color: var(--label);
        margin: 0;
        font-weight: var(--weight-semibold);
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
    }

    &__icon {
        width: var(--icon-xs);
        height: var(--icon-xs);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--label-secondary);
    }

    &__name {
        @include text-ellipsis;
    }

    &__count {
        font-size: var(--text-xs);
        color: var(--label-secondary);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }

    &__add {
        @include button-reset;
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        height: var(--control-h-xs);
        padding: 0 var(--space-3);
        border-radius: var(--control-radius);
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        color: var(--label-secondary);
        @include spring-transition(background color, var(--dur-fast));

        &:hover {
            background: var(--hover-bg);
            color: var(--label);
        }
    }
}
</style>
