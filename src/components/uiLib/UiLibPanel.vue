<!--
  UiLibPanel - 图标库统一面板
  集浏览、搜索与分类/图标管理于一体（替代原 UiLibPicker + UiLibManager 两层弹窗）。
  系统数据仅可查看，用户分类与图标支持删除；点击图标卡片可预览大图。
-->
<template>
    <ModalOverlay
        v-model="isOpen"
        size="lg"
        max-height="80vh"
        @close="emit('close')"
    >
        <template #header>
            <div class="ui-lib-panel__title">
                <IconSvg name="picture" size="var(--icon-sm)" />
                <span>图标库</span>
            </div>
        </template>

        <div class="ui-lib-panel">
            <div class="ui-lib-panel__search">
                <BaseInput
                    v-model="searchKeyword"
                    placeholder="搜索图标…"
                    autocomplete="off"
                >
                    <template #prefix>
                        <IconSvg name="search" size="var(--icon-xs)" />
                    </template>
                </BaseInput>
            </div>

            <div v-if="store.isLoading" class="ui-lib-panel__state">
                <IconSvg name="refresh" size="var(--icon-md)" />
                <p>图标库加载中…</p>
            </div>

            <template v-else>
                <div class="ui-lib-panel__tabs" role="tablist">
                    <button
                        v-for="cat in categories"
                        :key="cat.id"
                        type="button"
                        class="ui-lib-panel__tab"
                        :class="{ 'is-active': activeCategoryId === cat.id }"
                        role="tab"
                        :aria-selected="activeCategoryId === cat.id"
                        @click="activeCategoryId = cat.id"
                    >
                        {{ cat.name }}
                        <span class="ui-lib-panel__tab-count">{{ countByCategory[cat.id] || 0 }}</span>
                        <span
                            v-if="!isSystemCategory(cat.id) && activeCategoryId === cat.id"
                            class="ui-lib-panel__tab-delete"
                            role="button"
                            aria-label="删除分类"
                            @click.stop="deleteCategory(cat.id, cat.name)"
                        >
                            <IconSvg name="close" size="var(--icon-xs)" />
                        </span>
                    </button>

                    <button
                        v-if="!addingCategory"
                        type="button"
                        class="ui-lib-panel__tab-add"
                        aria-label="新建分类"
                        title="新建分类"
                        @click="startAddCategory"
                    >
                        <IconSvg name="plus" size="var(--icon-xs)" />
                    </button>
                    <input
                        v-else
                        ref="categoryInputRef"
                        v-model="newCategoryName"
                        type="text"
                        class="ui-lib-panel__tab-input"
                        placeholder="分类名称"
                        aria-label="新分类名称"
                        @keydown.enter="addCategory"
                        @keydown.esc="cancelAddCategory"
                        @blur="cancelAddCategory"
                    />
                </div>

                <div class="ui-lib-panel__content" role="tabpanel">
                    <div v-if="visibleItems.length === 0" class="ui-lib-panel__state">
                        <IconSvg name="picture" size="var(--icon-lg)" />
                        <p>{{ emptyText }}</p>
                    </div>

                    <div v-else class="ui-lib-panel__grid">
                        <button
                            v-for="item in visibleItems"
                            :key="item.id"
                            type="button"
                            class="ui-lib-panel__item"
                            :title="item.name"
                            @click="previewItem(item)"
                        >
                            <span
                                v-if="!item.isSystem"
                                class="ui-lib-panel__item-delete"
                                role="button"
                                aria-label="删除图标"
                                @click.stop="deleteItem(item.id, item.name)"
                            >
                                <IconSvg name="close" size="var(--icon-xs)" />
                            </span>
                            <span class="ui-lib-panel__icon">
                                <IconSvg :src="item.url" size="var(--icon-md)" :alt="item.name" />
                            </span>
                            <span class="ui-lib-panel__item-name">{{ item.name }}</span>
                        </button>
                    </div>

                    <div v-if="addingItem" class="ui-lib-panel__item-form">
                        <BaseInput
                            v-model="itemName"
                            label="图标名称"
                            placeholder="例如：Vue"
                        />
                        <BaseInput
                            v-model="itemUrl"
                            type="url"
                            label="图标 URL"
                            placeholder="https://.../logo.svg"
                            hint="支持网络地址或本地路径，不支持 data URL"
                        />
                        <SelectField
                            id="ui-lib-panel-item-category"
                            v-model="itemCategory"
                            label="所属分类"
                            placeholder="请选择分类"
                            :options="categorySelectOptions"
                        />
                        <div class="ui-lib-panel__form-actions">
                            <BaseButton variant="text" size="small" @click="cancelAddItem">取消</BaseButton>
                            <BaseButton
                                variant="primary"
                                size="small"
                                :loading="isAddingItem"
                                @click="addItem"
                            >
                                添加图标
                            </BaseButton>
                        </div>
                    </div>
                    <button
                        v-else
                        type="button"
                        class="ui-lib-panel__add-row"
                        @click="startAddItem"
                    >
                        <IconSvg name="plus" size="var(--icon-sm)" />
                        <span>添加图标</span>
                    </button>
                </div>
            </template>
        </div>

        <template #footer>
            <span class="ui-lib-panel__footer-total">
                共 {{ categories.length }} 个分类 · {{ items.length }} 个图标
            </span>
            <BaseButton variant="text" size="small" @click="close">关闭</BaseButton>
        </template>
    </ModalOverlay>

    <!-- 预览层：与主面板同走 --z-panel，靠声明顺序（Teleport 追加在后面）压在主面板之上 -->
    <ModalOverlay
        v-model="previewVisible"
        title="图标预览"
        size="sm"
    >
        <div v-if="previewTarget" class="ui-lib-panel__preview">
            <div class="ui-lib-panel__preview-box">
                <IconSvg :src="previewTarget.url" size="var(--icon-2xl)" :alt="previewTarget.name" />
            </div>
            <div class="ui-lib-panel__preview-name">{{ previewTarget.name }}</div>
            <div class="ui-lib-panel__preview-desc">
                {{ getCategoryName(previewTarget.category) }}
                <template v-if="previewTarget.isSystem"> · 系统图标</template>
            </div>
        </div>
    </ModalOverlay>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ModalOverlay from '@/components/common/ModalOverlay.vue';
import BaseButton from '@/components/common/BaseButton.vue';
import BaseInput from '@/components/common/BaseInput.vue';
import SelectField from '@/components/common/SelectField.vue';
import IconSvg from '@/components/icon/IconSvg.vue';
import { useUiLibStore } from '@/stores/uiLib.store';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import type { UiItem } from '@/types/ui';

/** 组件 Props */
interface Props {
    /** 是否显示面板（支持 v-model） */
    modelValue: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
    /** 面板显示状态变化 */
    (e: 'update:modelValue', value: boolean): void;
    /** 面板关闭 */
    (e: 'close'): void;
}>();

const store = useUiLibStore();
const confirm = useConfirm();
const toast = useToast();

const searchKeyword = ref('');
const activeCategoryId = ref('');

const addingCategory = ref(false);
const newCategoryName = ref('');
const categoryInputRef = ref<HTMLInputElement | null>(null);

const addingItem = ref(false);
const itemName = ref('');
const itemUrl = ref('');
const itemCategory = ref('');
const isAddingItem = ref(false);

const previewVisible = ref(false);
const previewTarget = ref<UiItem | null>(null);

const isOpen = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value),
});

const categories = computed(() => store.categories);
const items = computed(() => store.items);

/** 新增表单的分类下拉项 */
const categorySelectOptions = computed(() =>
    categories.value.map((category) => ({ value: category.id, label: category.name }))
);

/** 各分类下的图标数量 */
const countByCategory = computed(() => {
    const counts: Record<string, number> = {};
    for (const item of items.value) {
        counts[item.category] = (counts[item.category] || 0) + 1;
    }
    return counts;
});

/** 当前可见图标：有关键词时跨分类按名称过滤，否则按当前分类 */
const visibleItems = computed(() => {
    const keyword = searchKeyword.value.trim().toLowerCase();
    if (keyword) {
        return items.value.filter(item => item.name.toLowerCase().includes(keyword));
    }
    return items.value.filter(item => item.category === activeCategoryId.value);
});

const emptyText = computed(() => {
    if (searchKeyword.value.trim()) {
        return '未找到匹配的图标';
    }
    if (categories.value.length === 0) {
        return '暂无分类，点击上方 + 新建分类';
    }
    return '该分类下暂无图标';
});

/** 打开时初始化 store 并重置面板状态 */
watch(
    () => props.modelValue,
    async (visible) => {
        if (visible) {
            searchKeyword.value = '';
            addingCategory.value = false;
            newCategoryName.value = '';
            cancelAddItem();
            await store.init();
            if (!activeCategoryId.value && categories.value.length > 0) {
                activeCategoryId.value = categories.value[0].id;
            }
        }
    },
    { immediate: true }
);

/** 分类变化后，若当前分类不存在则回退到第一个 */
watch(
    () => categories.value.map(c => c.id).join(','),
    () => {
        if (!categories.value.some(c => c.id === activeCategoryId.value)) {
            activeCategoryId.value = categories.value[0]?.id ?? '';
        }
    }
);

function isSystemCategory(id: string): boolean {
    return !store.userCategoryIds.has(id);
}

function getCategoryName(categoryId: string): string {
    return categories.value.find(c => c.id === categoryId)?.name ?? '未分类';
}

// ==================== 分类管理 ====================

function startAddCategory(): void {
    addingCategory.value = true;
    newCategoryName.value = '';
    nextTick(() => {
        categoryInputRef.value?.focus();
    });
}

function cancelAddCategory(): void {
    addingCategory.value = false;
    newCategoryName.value = '';
}

async function addCategory(): Promise<void> {
    const name = newCategoryName.value.trim();
    if (!name) {
        toast.error('请输入分类名称');
        return;
    }
    try {
        const created = await store.addCategory({ name });
        cancelAddCategory();
        activeCategoryId.value = created.id;
        toast.success('分类已添加');
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '添加分类失败');
    }
}

async function deleteCategory(id: string, name: string): Promise<void> {
    const confirmed = await confirm.confirm(
        `确定要删除分类「${name}」吗？该分类下的图标也会一并删除。`,
        { title: '删除分类', isDanger: true }
    );
    if (!confirmed) {
        return;
    }
    try {
        await store.deleteCategory(id);
        toast.success('分类已删除');
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '删除分类失败');
    }
}

// ==================== 图标管理 ====================

function startAddItem(): void {
    if (categories.value.length === 0) {
        toast.error('请先新建分类');
        return;
    }
    addingItem.value = true;
    itemName.value = '';
    itemUrl.value = '';
    itemCategory.value = activeCategoryId.value || categories.value[0]?.id || '';
}

function cancelAddItem(): void {
    addingItem.value = false;
    itemName.value = '';
    itemUrl.value = '';
    itemCategory.value = '';
}

async function addItem(): Promise<void> {
    if (!itemCategory.value) {
        toast.error('请选择图标分类');
        return;
    }
    const name = itemName.value.trim();
    if (!name) {
        toast.error('请输入图标名称');
        return;
    }
    const url = itemUrl.value.trim();
    if (!url) {
        toast.error('请输入图标 URL');
        return;
    }

    isAddingItem.value = true;
    try {
        await store.addItem({ name, url, category: itemCategory.value });
        cancelAddItem();
        toast.success('图标已添加');
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '添加图标失败');
    } finally {
        isAddingItem.value = false;
    }
}

async function deleteItem(id: string, name: string): Promise<void> {
    const confirmed = await confirm.confirm(`确定要删除图标「${name}」吗？`, {
        title: '删除图标',
        isDanger: true,
    });
    if (!confirmed) {
        return;
    }
    try {
        await store.deleteItem(id);
        toast.success('图标已删除');
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '删除图标失败');
    }
}

function previewItem(item: UiItem): void {
    previewTarget.value = item;
    previewVisible.value = true;
}

function close(): void {
    isOpen.value = false;
    emit('close');
}
</script>

<style scoped lang="scss">
@use '@/styles/mixins.scss' as *;

.ui-lib-panel {
    display: flex;
    flex-direction: column;
    min-height: var(--panel-body-min-h);

    &__title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-lg);
        font-weight: var(--weight-semibold);
        color: var(--label);
    }

    &__footer-total {
        margin-right: auto;
        font-size: var(--text-xs);
        color: var(--label-secondary);
    }

    &__search {
        padding: var(--space-3) var(--space-6) 0;
    }

    &__state {
        flex: 1;
        @include flex-center(column, var(--space-3));
        padding: var(--space-12) var(--space-6);
        color: var(--label-secondary);
        font-size: var(--text-base);

        p {
            margin: 0;
        }
    }

    &__tabs {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-6);
        border-bottom: 1px solid var(--card-border);
        overflow-x: auto;
        @include hide-scrollbar;
    }

    &__tab {
        @include button-reset;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--card-border);
        background: transparent;
        color: var(--label);
        font-size: var(--text-sm);
        white-space: nowrap;
        @include spring-transition(all, var(--dur-fast));
        @include focus-ring;

        &:hover {
            background: var(--fill-tertiary);
        }

        &.is-active {
            background: var(--accent);
            color: var(--on-accent);
            border-color: var(--accent);
        }
    }

    &__tab-count {
        font-size: var(--text-xs);
        padding: 0 var(--space-1);
        border-radius: var(--radius-full);
        background: var(--tint-primary);
        color: var(--accent);

        .is-active & {
            background: color-mix(in srgb, var(--on-accent) 22%, transparent);
            color: var(--on-accent);
        }
    }

    &__tab-delete {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: var(--radius-full);
        cursor: pointer;
        @include spring-transition(background, var(--dur-fast));

        &:hover {
            background: color-mix(in srgb, var(--on-accent) 28%, transparent);
        }
    }

    &__tab-add {
        @include button-reset;
        width: 30px;
        height: 30px;
        border-radius: var(--radius-full);
        border: 1.5px dashed var(--card-border);
        color: var(--label-secondary);
        flex-shrink: 0;
        @include flex-center(row, 0);
        @include spring-transition(all, var(--dur-fast));
        @include focus-ring;

        &:hover {
            border-color: var(--label-tertiary);
            color: var(--label);
            background: var(--fill-tertiary);
        }
    }

    &__tab-input {
        width: 120px;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--accent);
        background: var(--card-bg);
        color: var(--label);
        font-size: var(--text-sm);
        font-family: inherit;
        flex-shrink: 0;
    }

    &__content {
        flex: 1;
        padding: var(--space-4) var(--space-6);
        @include scrollable;
    }

    &__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
        gap: var(--space-3);
    }

    &__item {
        @include button-reset;
        // 可点磁贴走卡片契约：hover 只抬 elevation，不换描边色
        @include card-interactive;
        position: relative;
        aspect-ratio: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        padding: var(--space-2);
        @include focus-ring;
    }

    &__item-delete {
        position: absolute;
        top: var(--space-1);
        right: var(--space-1);
        width: 18px;
        height: 18px;
        border-radius: var(--radius-full);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: var(--color-error);
        background: var(--tint-error);
        opacity: 0;
        @include spring-transition(opacity, var(--dur-fast));

        .ui-lib-panel__item:hover &,
        .ui-lib-panel__item:focus-visible & {
            opacity: 1;
        }
    }

    &__icon {
        width: var(--tile-icon-size);
        height: var(--tile-icon-size);
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--tint-primary);
    }

    &__item-name {
        font-size: var(--text-xs);
        color: var(--label-secondary);
        text-align: center;
        @include text-ellipsis;
        width: 100%;
    }

    &__add-row {
        @include button-reset;
        margin-top: var(--space-3);
        width: 100%;
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        border: 1.5px dashed var(--card-border);
        color: var(--label-secondary);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        @include flex-center(row, var(--space-2));
        @include spring-transition(all, var(--dur-fast));
        @include focus-ring;

        &:hover {
            border-color: var(--label-tertiary);
            color: var(--label);
            background: var(--fill-tertiary);
        }
    }

    &__item-form {
        margin-top: var(--space-3);
        padding: var(--space-4);
        border-radius: var(--radius-md);
        border: 1px solid var(--tint-primary-strong);
        background: color-mix(in srgb, var(--accent) 4%, transparent);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
    }

    &__form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
    }

    &__preview {
        padding: var(--space-4) var(--space-2);
        text-align: center;
    }

    &__preview-box {
        // 预览底板直接取磁贴档，不再自写一个 120px 的孤例方盒
        width: var(--tile-size);
        height: var(--tile-size);
        margin: 0 auto var(--space-4);
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fill);
        border: 1px solid var(--card-border);
        border-radius: var(--radius-lg);
    }

    &__preview-name {
        font-size: var(--text-lg);
        font-weight: var(--weight-medium);
        color: var(--label);
        margin-bottom: var(--space-2);
    }

    &__preview-desc {
        font-size: var(--text-sm);
        color: var(--label-secondary);
    }
}
</style>
