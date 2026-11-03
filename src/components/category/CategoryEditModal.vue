<script setup lang="ts">
/**
 * CategoryEditModal - 分类添加/编辑模态框
 *
 * 提供分类名称、浅色/深色图标、单色模式开关表单，
 * 直接通过 useDataManager 完成新增或更新。
 */
import { computed, ref, watch } from 'vue';
import type { Category, CategoryInput } from '@/types/app';
import { useDataManager } from '@/composables/useDataManager';
import { useToast } from '@/composables/useToast';
import ModalOverlay from '@/components/common/ModalOverlay.vue';
import BaseInput from '@/components/common/BaseInput.vue';
import BaseButton from '@/components/common/BaseButton.vue';
import IconSvg from '@/components/icon/IconSvg.vue';

export interface CategoryEditModalProps {
    /** 是否显示模态框（支持 v-model） */
    modelValue: boolean;
    /** 传入时表示编辑该分类；未传入时表示新增 */
    category?: Category;
}

const props = defineProps<CategoryEditModalProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'saved', category: Category): void;
    (e: 'close'): void;
}>();

const dataManager = useDataManager({ autoInit: false });
const { uiItems } = dataManager;
const toast = useToast();

const DEFAULT_ICON = './image/icons/folder.svg';

const isEdit = computed(() => !!props.category);
const modalTitle = computed(() => (isEdit.value ? '编辑分类' : '添加分类'));

const form = ref<CategoryInput>({
    name: '',
    icon: '',
    iconDark: '',
    monochrome: false,
});
const isSubmitting = ref(false);
const nameError = ref('');
const showPresetIcons = ref(false);
const activeIconField = ref<'light' | 'dark'>('light');

/** 与当前输入同名的已有分类（编辑时排除自身） */
const duplicateCategory = computed(() => {
    const name = form.value.name.trim();
    if (!name) return undefined;
    return dataManager.findCategoryByName(name, props.category?.id);
});

function resetForm(): void {
    form.value = {
        name: props.category?.name ?? '',
        icon: props.category?.icon ?? '',
        iconDark: props.category?.iconDark ?? '',
        monochrome: props.category?.monochrome ?? false,
    };
    nameError.value = '';
    showPresetIcons.value = false;
}

watch(
    () => props.modelValue,
    (open) => {
        if (open) {
            resetForm();
            // 确保 UI 图标库已初始化，供图标选择网格使用（幂等）
            dataManager.init().catch(() => undefined);
        }
    },
    { immediate: true }
);

watch(() => props.category, resetForm, { immediate: true });

function handleClose(): void {
    emit('update:modelValue', false);
    emit('close');
}

function validate(): boolean {
    nameError.value = '';
    if (!form.value.name.trim()) {
        nameError.value = '请输入分类名称';
        return false;
    }
    if (duplicateCategory.value) {
        nameError.value = `分类「${duplicateCategory.value.name}」已存在，请换一个名称`;
        return false;
    }
    return true;
}

async function handleSave(): Promise<void> {
    if (isSubmitting.value || !validate()) return;

    isSubmitting.value = true;
    try {
        const payload: CategoryInput = {
            name: form.value.name.trim(),
            icon: (form.value.icon || '').trim() || DEFAULT_ICON,
            monochrome: form.value.monochrome,
        };
        const iconDark = form.value.iconDark?.trim();
        if (iconDark) {
            payload.iconDark = iconDark;
        }

        let result: Category;
        if (isEdit.value && props.category) {
            const updated = await dataManager.updateCategory(props.category.id, payload);
            if (!updated) {
                throw new Error('分类不存在或已删除');
            }
            result = updated;
            toast.success('分类已更新');
        } else {
            result = await dataManager.addCategory(payload);
            toast.success('分类已添加');
        }

        emit('saved', result);
        handleClose();
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
        isSubmitting.value = false;
    }
}

function restoreDefaultIcon(): void {
    form.value.icon = DEFAULT_ICON;
    form.value.iconDark = '';
    form.value.monochrome = false;
    showPresetIcons.value = false;
}

function openPresetIcons(field: 'light' | 'dark'): void {
    activeIconField.value = field;
    showPresetIcons.value = true;
}

/** 从 UI 图标库选择图标，填入当前目标字段 */
function selectIcon(url: string): void {
    if (activeIconField.value === 'dark') {
        form.value.iconDark = url;
    } else {
        form.value.icon = url;
    }
    showPresetIcons.value = false;
}

const lightPreviewSrc = computed(() => form.value.icon?.trim() || DEFAULT_ICON);
const darkPreviewSrc = computed(() => form.value.iconDark?.trim() || lightPreviewSrc.value);

/** 当前目标字段已选中的图标 URL，用于常用图标网格的选中高亮 */
const activePresetIcon = computed(() =>
    activeIconField.value === 'dark' ? form.value.iconDark?.trim() : form.value.icon?.trim()
);
</script>

<template>
    <ModalOverlay
        :model-value="modelValue"
        :title="modalTitle"
        size="sm"
        close-on-overlay
        close-on-esc
        @update:model-value="$emit('update:modelValue', $event)"
        @close="handleClose"
    >
        <form class="mnt-category-form" @submit.prevent="handleSave">
            <BaseInput
                v-model="form.name"
                label="分类名称"
                placeholder="例如：开发工具"
                :required="true"
                :error="nameError"
                autocomplete="off"
            />

            <p v-if="duplicateCategory && !nameError" class="mnt-category-form__warning">
                已有同名分类「{{ duplicateCategory.name }}」，请换一个名称
            </p>

            <div class="mnt-category-form__group">
                <div class="mnt-category-form__group-header">
                    <label class="mnt-category-form__label">分类图标</label>
                    <BaseButton
                        variant="text"
                        size="small"
                        class="mnt-category-form__restore-btn"
                        @click="restoreDefaultIcon"
                    >
                        恢复默认
                    </BaseButton>
                </div>

                <div class="mnt-category-form__icon-row">
                    <span class="mnt-category-form__icon-label">浅色</span>
                    <BaseInput
                        v-model="form.icon"
                        placeholder="图标 URL 或系统图标名称"
                        autocomplete="off"
                    >
                        <template #prefix>
                            <IconSvg :src="lightPreviewSrc" size="var(--icon-sm)" :monochrome="form.monochrome" />
                        </template>
                    </BaseInput>
                    <BaseButton
                        variant="secondary"
                        size="small"
                        aria-label="选择浅色图标"
                        @click="openPresetIcons('light')"
                    >
                        <template #icon>
                            <IconSvg name="picture" size="var(--icon-xs)" />
                        </template>
                        选择
                    </BaseButton>
                </div>

                <div class="mnt-category-form__icon-row">
                    <span class="mnt-category-form__icon-label">深色</span>
                    <BaseInput
                        v-model="form.iconDark"
                        placeholder="深色模式图标（可选）"
                        autocomplete="off"
                    >
                        <template #prefix>
                            <IconSvg :src="darkPreviewSrc" size="var(--icon-sm)" :monochrome="form.monochrome" />
                        </template>
                    </BaseInput>
                    <BaseButton
                        variant="secondary"
                        size="small"
                        aria-label="选择深色图标"
                        @click="openPresetIcons('dark')"
                    >
                        <template #icon>
                            <IconSvg name="picture" size="var(--icon-xs)" />
                        </template>
                        选择
                    </BaseButton>
                </div>

                <div class="mnt-category-form__preview-row">
                    <div class="mnt-category-form__preview-item">
                        <div
                            class="mnt-category-form__preview-box mnt-category-form__preview-box--light"
                            aria-label="浅色模式预览"
                        >
                            <IconSvg
                                :src="lightPreviewSrc"
                                size="var(--icon-lg)"
                                :monochrome="form.monochrome"
                            />
                        </div>
                        <span class="mnt-category-form__preview-label">浅色</span>
                    </div>
                    <div class="mnt-category-form__preview-item">
                        <div
                            class="mnt-category-form__preview-box mnt-category-form__preview-box--dark"
                            aria-label="深色模式预览"
                        >
                            <IconSvg
                                :src="darkPreviewSrc"
                                size="var(--icon-lg)"
                                :monochrome="form.monochrome"
                                style="--icon-filter: invert(1) brightness(2)"
                            />
                        </div>
                        <span class="mnt-category-form__preview-label">深色</span>
                    </div>
                </div>

                <label class="mnt-category-form__checkbox">
                    <input v-model="form.monochrome" type="checkbox" />
                    <span>深色模式下图标增加反色遮罩</span>
                </label>

                <Transition name="mnt-category-form__presets">
                    <div v-if="showPresetIcons" class="mnt-category-form__presets">
                        <p class="mnt-category-form__presets-title">
                            选择图标
                            <span class="mnt-category-form__presets-target">
                                应用到：{{ activeIconField === 'dark' ? '深色' : '浅色' }}图标
                            </span>
                        </p>
                        <div v-if="uiItems.length === 0" class="mnt-category-form__picker-empty">
                            暂无可用图标
                        </div>
                        <div v-else class="mnt-category-form__presets-grid">
                            <button
                                v-for="item in uiItems"
                                :key="item.id"
                                type="button"
                                class="mnt-category-form__picker-item"
                                :class="{
                                    'mnt-category-form__picker-item--active':
                                        activePresetIcon === item.url,
                                }"
                                :title="item.name"
                                :aria-label="`选择图标 ${item.name}`"
                                @click="selectIcon(item.url)"
                            >
                                <IconSvg :src="item.url" size="var(--icon-sm)" :alt="item.name" />
                            </button>
                        </div>
                    </div>
                </Transition>
            </div>
        </form>

        <template #footer>
            <BaseButton variant="text" @click="handleClose">取消</BaseButton>
            <BaseButton
                variant="primary"
                :loading="isSubmitting"
                :disabled="isSubmitting"
                @click="handleSave"
            >
                保存
            </BaseButton>
        </template>
    </ModalOverlay>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-category-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);

    &__group {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
    }

    &__warning {
        margin: calc(var(--space-2) * -1) 0 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        line-height: var(--leading-normal);
        color: var(--on-warning);
        background: var(--tint-warning);
    }

    &__group-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
    }

    &__label {
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
        color: var(--md-sys-color-on-surface);
    }

    &__restore-btn {
        flex-shrink: 0;
    }

    &__icon-row {
        display: grid;
        grid-template-columns: 36px 1fr auto;
        align-items: center;
        gap: var(--space-2);
    }

    &__icon-label {
        font-size: var(--text-xs);
        color: var(--md-sys-color-on-surface-variant);
        text-align: right;
    }

    &__preview-row {
        display: flex;
        gap: var(--space-4);
        margin-top: var(--space-1);
    }

    &__preview-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
    }

    &__preview-box {
        width: 64px;
        height: 64px;
        border-radius: var(--radius-md);
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--md-sys-color-outline-variant);
        box-shadow: var(--elevation-1);
        overflow: hidden;
        @include md-transition(box-shadow, var(--md-transition-fast));

        &:hover {
            box-shadow: var(--elevation-2);
        }

        &--light {
            background: var(--md-sys-color-surface);
        }

        // 反色表面给出「与当前主题相反的那一档」预览底，不再写死深底：
        // 内置单色图标走 CSS mask，颜色取 currentColor，所以深色预览盒
        // 用反色前景就够了，不依赖 --icon-filter 反转。
        &--dark {
            background: var(--md-sys-color-inverse-surface);
            color: var(--md-sys-color-inverse-on-surface);
        }
    }

    &__preview-label {
        font-size: var(--text-xs);
        color: var(--md-sys-color-on-surface-variant);
    }

    &__checkbox {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--md-sys-color-on-surface-variant);

        input[type='checkbox'] {
            width: 18px;
            height: 18px;
            cursor: pointer;
            accent-color: var(--md-sys-color-primary);
        }
    }

    &__presets {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4) var(--space-4);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--md-sys-color-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent);
    }

    &__presets-title {
        @include section-label;
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
    }

    &__presets-target {
        font-size: var(--text-xs);
        font-weight: var(--weight-regular);
        color: var(--md-sys-color-primary);
    }

    &__presets-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
        max-height: 200px;
        overflow-y: auto;
        @include scrollable;
    }

    &__picker-empty {
        padding: var(--space-6) 0;
        text-align: center;
        font-size: var(--text-xs);
        color: var(--md-sys-color-on-surface-variant);
    }

    &__picker-item {
        @include button-reset;
        aspect-ratio: 1;
        border-radius: var(--radius-sm);
        background: var(--md-sys-color-surface);
        border: 1px solid var(--md-sys-color-outline-variant);
        color: var(--md-sys-color-on-surface-variant);
        @include flex-center(row, 0);
        @include md-transition(all, var(--md-transition-fast));

        &:hover {
            border-color: var(--md-sys-color-primary);
            color: var(--md-sys-color-primary);
            transform: translateY(-1px);
            box-shadow: var(--elevation-1);
        }

        &--active,
        &--active:hover {
            border-color: var(--md-sys-color-primary);
            background: var(--tint-primary);
            color: var(--md-sys-color-primary);
            transform: none;
        }
    }
}

.mnt-category-form__presets-enter-active,
.mnt-category-form__presets-leave-active {
    transition: all 0.2s var(--md-easing);
    overflow: hidden;
}

.mnt-category-form__presets-enter-from,
.mnt-category-form__presets-leave-to {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
}

.mnt-category-form__presets-enter-to,
.mnt-category-form__presets-leave-from {
    opacity: 1;
    max-height: 320px;
}
</style>
