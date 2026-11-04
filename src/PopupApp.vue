<script setup lang="ts">
/**
 * PopupApp.vue - 浏览器扩展 popup 根组件
 *
 * 自动读取当前活动标签页信息，提供快速添加网站到 HahaNewTab 的表单。
 */
import { computed, ref, watch } from 'vue';
import { useDataManager } from '@/composables/useDataManager';
import { useCurrentTab } from '@/composables/useCurrentTab';
import { useToast } from '@/composables/useToast';
import { getSystemIconUrl } from '@/utils/image.util';
import { getBrandLogo } from '@/utils/browser.util';
import { normalizeUrl } from '@/utils/url.util';
import { resolveIconSource } from '@/utils/iconSource.util';

import BaseInput from '@/components/common/BaseInput.vue';
import BaseButton from '@/components/common/BaseButton.vue';
import SelectField from '@/components/common/SelectField.vue';
import ToastContainer from '@/components/common/ToastContainer.vue';
import IconSvg from '@/components/icon/IconSvg.vue';

const NEW_CATEGORY_VALUE = '__new__';
// 须用绝对路径：popup 页面位于 view/ 子目录，相对路径会解析为 view/image/... 导致 404
const DEFAULT_ICON = getSystemIconUrl('picture');
const HOME_PAGE_URL = 'https://github.com/AlexCat315/HahaNewTab';
/** 品牌 Logo（全浏览器统一使用 logo_girl） */
const brandLogo = getBrandLogo();

const dataManager = useDataManager({ autoInit: true });
const { title: tabTitle, url: tabUrl, favicon, isValid, isLoading } = useCurrentTab({ autoRefresh: true });
const toast = useToast();

interface FormState {
    name: string;
    url: string;
    category: string;
    newCategoryName: string;
    description: string;
    icon: string;
}

const form = ref<FormState>({
    name: '',
    url: '',
    category: '',
    newCategoryName: '',
    description: '',
    icon: '',
});

const errors = ref<Record<string, string>>({});
const isSubmitting = ref(false);
/** 图标源探测中：多个候选地址 + 首页 HTML，最坏几秒，需要挡住重复点击 */
const isFetchingIcon = ref(false);

const isNewCategory = computed(() => form.value.category === NEW_CATEGORY_VALUE);
const categoryOptions = computed(() => dataManager.userCategories.value);
/** 下拉项：已有分类 + 「新建分类」；placeholder 由 SelectField 负责渲染 */
const categorySelectOptions = computed(() => [
    ...categoryOptions.value.map((category) => ({ value: category.id, label: category.name })),
    { value: NEW_CATEGORY_VALUE, label: '+ 新建分类' },
]);
const effectiveIcon = computed(() => form.value.icon?.trim() || DEFAULT_ICON);

/** 当前标签页网址是否已经在导航里 */
const duplicateApp = computed(() => {
    const url = form.value.url.trim();
    if (!url) return undefined;
    return dataManager.findAppByUrl(url);
});

/** 重复站点所在分类名 */
const duplicateCategoryName = computed(() => {
    const duplicate = duplicateApp.value;
    if (!duplicate) return '';
    return dataManager.getCategoryById(duplicate.category)?.name ?? '未分类';
});

/** 自动获取图标：探测该站点能拿到的最大源图 */
async function autoFetchIcon(): Promise<void> {
    const url = form.value.url.trim();
    if (!url) {
        toast.error('请先输入网站链接');
        return;
    }
    if (isFetchingIcon.value) return;

    isFetchingIcon.value = true;
    try {
        const icon = await resolveIconSource(url);
        if (!icon) {
            toast.error('无法解析网站链接');
            return;
        }
        form.value.icon = icon;
        toast.success('图标已自动获取');
    } finally {
        isFetchingIcon.value = false;
    }
}

/** URL 失焦且图标为空时自动获取图标 */
function handleUrlBlur(): void {
    if (!form.value.icon.trim() && form.value.url.trim()) {
        autoFetchIcon().catch(() => undefined);
    }
}

/** 清除图标 */
function clearIcon(): void {
    form.value.icon = '';
}

/** 重置表单 */
function resetForm(): void {
    errors.value = {};
    isFetchingIcon.value = false;
    form.value = {
        name: tabTitle.value,
        url: tabUrl.value,
        category: '',
        newCategoryName: '',
        description: '',
        icon: favicon.value,
    };
}

/** 表单校验 */
function validate(): boolean {
    errors.value = {};

    if (!form.value.name.trim()) {
        errors.value.name = '请输入网站名称';
    }

    const url = form.value.url.trim();
    if (!url) {
        errors.value.url = '请输入网站链接';
    } else {
        try {
            new URL(normalizeUrl(url));
        } catch {
            errors.value.url = '请输入有效的网址';
        }
        if (!errors.value.url && duplicateApp.value) {
            errors.value.url = `该网站已存在：${duplicateApp.value.name}（分类：${duplicateCategoryName.value}）`;
        }
    }

    if (!form.value.category) {
        errors.value.category = '请选择所属分类';
    }

    if (isNewCategory.value && !form.value.newCategoryName.trim()) {
        errors.value.newCategoryName = '请输入新分类名称';
    }

    const hasError = Object.keys(errors.value).length > 0;
    if (hasError) {
        toast.error('请填写必填项');
    }
    return !hasError;
}

/** 保存网站 */
async function handleSubmit(): Promise<void> {
    if (!validate()) return;

    isSubmitting.value = true;
    try {
        let categoryId = form.value.category;

        if (categoryId === NEW_CATEGORY_VALUE) {
            // 同名分类已存在时直接复用，避免「新建分类」撞名报错
            const existing = dataManager.findCategoryByName(form.value.newCategoryName);
            if (existing) {
                categoryId = existing.id;
            } else {
                const newCategory = await dataManager.addCategory({
                    name: form.value.newCategoryName.trim(),
                });
                categoryId = newCategory.id;
            }
        }

        await dataManager.addApp({
            name: form.value.name.trim(),
            url: normalizeUrl(form.value.url),
            category: categoryId,
            description: form.value.description.trim(),
            icon: form.value.icon.trim() || undefined,
        });

        toast.success('网站已添加');
        // 延迟关闭 popup，给用户留出看到成功提示的时间
        setTimeout(() => {
            window.close();
        }, 1500);
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
        isSubmitting.value = false;
    }
}

/** 打开主页 */
function openHomePage(): void {
    window.open(HOME_PAGE_URL, '_blank');
}

// 监听当前标签页变化，自动填充
watch(
    () => [tabTitle.value, tabUrl.value, favicon.value],
    () => {
        if (isValid.value) {
            resetForm();
        }
    },
    { immediate: true }
);

// 数据初始化完成后，若分类列表只有默认分类则默认选中第一个
watch(
    () => dataManager.userCategories.value.length,
    (length) => {
        if (length > 0 && !form.value.category) {
            form.value.category = dataManager.userCategories.value[0].id;
        }
    }
);
</script>

<template>
    <div id="popup-root" class="popup-root">
        <header class="popup-header">
            <button type="button" class="popup-brand" @click="openHomePage">
                <img :src="brandLogo" alt="Haha" class="popup-logo" />
                <span class="popup-title">添加到 Haha新标签页</span>
            </button>
        </header>

        <main class="popup-body">
            <div v-if="isLoading" class="popup-state">
                <span class="popup-state-plate">
                    <IconSvg name="refresh" size="var(--icon-lg)" />
                </span>
                <p>读取当前标签页…</p>
            </div>

            <div v-else-if="!isValid" class="popup-state popup-state--error">
                <span class="popup-state-plate popup-state-plate--error">
                    <IconSvg name="warning" size="var(--icon-lg)" />
                </span>
                <p>当前页面无法添加</p>
                <span class="popup-state-hint">不支持 chrome://、about: 等浏览器内部页面</span>
            </div>

            <form v-else class="popup-form" @submit.prevent="handleSubmit">
                <BaseInput
                    v-model="form.name"
                    label="网站名称"
                    placeholder="例如：GitHub"
                    required
                    :error="errors.name"
                />

                <BaseInput
                    v-model="form.url"
                    label="网站链接"
                    type="url"
                    placeholder="https://..."
                    required
                    :error="errors.url"
                    @blur="handleUrlBlur"
                />

                <p v-if="duplicateApp && !errors.url" class="popup-warning">
                    <IconSvg name="warning" size="var(--icon-xs)" />
                    <span>
                        该网站已存在：{{ duplicateApp.name }}（分类：{{ duplicateCategoryName }}），无需重复添加
                    </span>
                </p>

                <SelectField
                    v-model="form.category"
                    label="所属分类"
                    required
                    placeholder="请选择分类"
                    :options="categorySelectOptions"
                    :error="errors.category"
                />

                <BaseInput
                    v-if="isNewCategory"
                    v-model="form.newCategoryName"
                    label="新分类名称"
                    placeholder="例如：学习资源"
                    required
                    :error="errors.newCategoryName"
                />

                <BaseInput
                    v-model="form.description"
                    label="备注描述"
                    placeholder="简短描述网站用途..."
                />

                <div class="form-group">
                    <label class="form-label">图标预览</label>

                    <div class="icon-selector">
                        <div class="icon-preview">
                            <IconSvg
                                :src="effectiveIcon"
                                size="var(--icon-lg)"
                                :fallback="DEFAULT_ICON"
                                alt="图标预览"
                            />
                        </div>
                        <BaseInput
                            v-model="form.icon"
                            placeholder="图标 URL 或系统图标名称"
                            class="icon-input"
                        />
                    </div>

                    <div class="icon-actions">
                        <BaseButton
                            type="button"
                            variant="outlined"
                            size="small"
                            :loading="isFetchingIcon"
                            @click="autoFetchIcon"
                        >
                            <template #icon>
                                <IconSvg name="refresh" size="var(--icon-xs)" />
                            </template>
                            自动获取
                        </BaseButton>
                        <BaseButton
                            type="button"
                            variant="text"
                            size="small"
                            @click="clearIcon"
                        >
                            清除
                        </BaseButton>
                    </div>
                </div>
            </form>
        </main>

        <footer class="popup-footer">
            <BaseButton variant="text" size="small" @click="resetForm">
                重置
            </BaseButton>
            <BaseButton
                variant="primary"
                size="small"
                :loading="isSubmitting"
                :disabled="!isValid || isSubmitting"
                @click="handleSubmit"
            >
                保存网站
            </BaseButton>
        </footer>

        <ToastContainer position="top-right" />
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.popup-root {
    // popup 与 Toast 是同一列轻浮层，宽度取同一档
    width: var(--pop-w-toast);
    // 读取标签页期间的状态块很短，没有下限的话 popup 会在「加载 → 表单」之间跳高
    min-height: var(--panel-body-min-h);
    // 独立窗口不做材质：背后没有壁纸，半透明只会透出桌面的颜色。
    // 窗口底由 view/popup.html 的 body 给（--window-bg），这里保持透明，
    // 于是圆角和阴影交给 Chrome 自己的 popup 外壳，而不是我们在里面再画一层卡片。
    background: transparent;
    // 独立窗口不再自己画卡片圆角/投影，圆角交给 Chrome 的 popup 外壳
    border-radius: 0; // token-allow
    box-shadow: none;
    color: var(--label);
    display: flex;
    flex-direction: column;
}

// Apple 的窗口头部不是一块色带，而是同一张窗口底 + 一条 hairline：
// tint 底是 Material 的 app bar，换一族主题就换一种性格，标题还得跟着反色。
// 品牌感交给 logo 本身。
.popup-header {
    padding: var(--space-3) var(--space-4);
    background: transparent;
    @include hairline;
}

.popup-brand {
    @include button-reset;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: calc(var(--space-1) * -1);
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    text-align: left;
    @include spring-transition(background-color, var(--dur-fast));

    &:hover {
        background: var(--hover-bg);
    }
}

// 品牌图自带白底：原图直出，只做圆角，不加内边距/边框/投影
.popup-logo {
    width: var(--icon-lg);
    height: var(--icon-lg);
    object-fit: contain;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
}

.popup-title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--label);
}

.popup-body {
    flex: 1;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
}

.popup-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
}

.popup-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-8) var(--space-4);
    color: var(--label-secondary);
    text-align: center;

    p {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--label);
    }

    &--error p {
        color: var(--color-error);
    }
}

// 空状态图标垫一层圆底：裸图标漂在大片表面上，看起来像没加载出来的破图。
.popup-state-plate {
    width: var(--icon-2xl);
    height: var(--icon-2xl);
    border-radius: var(--radius-full);
    background: var(--hover-bg);
    color: var(--label-secondary);
    @include flex-center(row, 0);

    &--error {
        background: var(--tint-error);
        color: var(--color-error);
    }
}

.popup-state-hint {
    font-size: var(--text-xs);
    color: var(--label-secondary);
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

// 与 BaseInput / SelectField 的标签同一档：同一张表单里「所属分类」和「图标预览」
// 不能一个是 14px 中等、一个是 13px 半粗。
.form-label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--label);
}

.popup-warning {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    color: var(--on-warning);
    background: var(--tint-warning);

    :deep(.icon-svg) {
        margin-top: 1px;
        flex-shrink: 0;
        color: inherit;
    }
}

.icon-selector {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}

.icon-preview {
    // 底板边长取图标 xl 档，预览图标（lg）在里面正好留出一圈内衬
    width: var(--icon-xl);
    height: var(--icon-xl);
    flex-shrink: 0;
    border-radius: var(--radius-md);
    background: var(--fill);
    border: 1px solid var(--card-border);
    @include flex-center(row, 0);
}

.icon-input {
    flex: 1;
}

.icon-actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
}

.popup-footer {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--separator);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
}
</style>
