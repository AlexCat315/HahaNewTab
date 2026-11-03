<script setup lang="ts">
/**
 * SearchModal - 全局搜索模态框
 *
 * 整合搜索引擎选择、搜索输入、历史记录与关键词补全建议。
 * 通过 useSearch 组合式函数管理状态与业务操作。
 *
 * 快捷键：
 * - Enter：执行搜索 / 选中高亮建议
 * - ArrowDown/ArrowUp：移动建议高亮
 * - ArrowRight/Tab：光标在末尾时补全到建议词（输入框内有幽灵文本预览）
 * - Escape：关闭模态框（有建议时先清空建议）
 */
import { computed, nextTick, ref, watch } from 'vue';
import ModalOverlay from '@/components/common/ModalOverlay.vue';
import BaseInput from '@/components/common/BaseInput.vue';
import IconSvg from '@/components/icon/IconSvg.vue';
import EngineSelector from './EngineSelector.vue';
import SearchHistory from './SearchHistory.vue';
import SearchSuggestions from './SearchSuggestions.vue';
import { useSearch } from '@/composables/useSearch';
import type { SearchEngine } from '@/types/config';

export interface SearchModalProps {
    /** 是否显示（支持 v-model） */
    modelValue: boolean;
    /** 输入框占位提示 */
    placeholder?: string;
    /**
     * 宽度档，交给 ModalOverlay 映射到 --panel-w-*。
     * Cmd+K 是「读得下一行搜索结果」的面板，取 lg：md(520) 会让引擎名 +
     * 输入 + 补全提示挤在一起，xl(780) 又比首页搜索列宽得多，跳出了同一套尺寸语言。
     */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** 显式最大宽度，只给确实要偏离宽度档的调用方用；不传就走 size */
    maxWidth?: number | string;
}

const props = withDefaults(defineProps<SearchModalProps>(), {
    placeholder: '输入搜索内容…',
    size: 'lg'
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'search', payload: { query: string; engine: SearchEngine }): void;
}>();

const {
    query,
    engines,
    currentEngine,
    currentEngineIndex,
    suggestions,
    activeSuggestionIndex,
    isLoadingSuggestions,
    canSearch,
    hasSuggestions,
    history,
    executeSearch,
    executeSearchWithSuggestion,
    clearSuggestions,
    selectEngine,
    removeHistory,
    clearHistory,
    moveSuggestionDown,
    moveSuggestionUp,
    selectActiveSuggestion,
    getCompletionCandidate
} = useSearch({ debounceMs: 200, maxSuggestions: 10, maxLocalSuggestions: 5 });

const inputRef = ref<InstanceType<typeof BaseInput> | null>(null);
const isVisible = computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value)
});

const hasHistory = computed(() => history.value.length > 0);
/** 建议区：有结果就显示；无结果时只有「连历史都没有」才用骨架顶住 */
const showSuggestions = computed(
    () => hasSuggestions.value || (isLoadingSuggestions.value && !hasHistory.value)
);
/**
 * 历史：只要没有建议可显示就留在原位。
 *
 * 不再随 query 变空而卸载 —— 否则敲下第一个字的瞬间正文会空一段，
 * 等防抖走完骨架才出来，看起来就是「历史消失 → 骨架 → 列表」两次跳变。
 */
const showHistory = computed(() => hasHistory.value && !hasSuggestions.value);
/** 空状态只在「没输入 + 没历史 + 没骨架」时出现 */
const showEmptyState = computed(
    () => !query.value.trim() && !hasHistory.value && !showSuggestions.value
);

/**
 * 幽灵文本预览的补全后缀：
 * 仅当补全候选以当前 query 为前缀时展示剩余部分（高亮项未必是前缀匹配）。
 */
const ghostSuffix = computed(() => {
    const candidate = getCompletionCandidate();
    if (!candidate) {
        return '';
    }
    if (!candidate.toLowerCase().startsWith(query.value.toLowerCase())) {
        return '';
    }
    return candidate.slice(query.value.length);
});

/**
 * 聚焦输入框
 */
function focusInput(): void {
    nextTick(() => {
        const inputEl = inputRef.value?.$el?.querySelector('input');
        inputEl?.focus();
    });
}

/**
 * 关闭并清理建议
 */
function close(): void {
    clearSuggestions();
    isVisible.value = false;
}

/**
 * 提交搜索
 */
async function submitSearch(rawQuery?: string): Promise<void> {
    // executeSearch 成功后会清空 query，提前捕获保证事件载荷不丢关键词
    const text = (rawQuery ?? query.value).trim();
    const success = await executeSearch(rawQuery);
    if (success && currentEngine.value) {
        emit('search', { query: text, engine: currentEngine.value });
        close();
    }
}

/**
 * 选中建议并搜索
 */
async function selectSuggestion(suggestion: string): Promise<void> {
    const success = await executeSearchWithSuggestion(suggestion);
    if (success && currentEngine.value) {
        emit('search', { query: suggestion, engine: currentEngine.value });
        close();
    }
}

/**
 * 切换搜索引擎
 */
async function handleEngineSelect(index: number): Promise<void> {
    await selectEngine(index);
    focusInput();
}

/**
 * 使用历史记录搜索
 */
async function handleHistorySelect(historyQuery: string): Promise<void> {
    await selectSuggestion(historyQuery);
}

/**
 * 尝试用补全候选填充输入框（右箭头 / Tab）。
 * 仅在光标位于文本末尾时生效，返回是否已执行补全。
 */
function tryCompleteQuery(event: KeyboardEvent): boolean {
    const target = event.target as HTMLInputElement | null;
    if (!target || typeof target.selectionStart !== 'number') {
        return false;
    }

    const atEnd =
        target.selectionStart === target.value.length &&
        target.selectionEnd === target.value.length;
    if (!atEnd) {
        return false;
    }

    const candidate = getCompletionCandidate();
    if (!candidate) {
        return false;
    }

    event.preventDefault();
    query.value = candidate;
    return true;
}

/**
 * 处理输入框键盘事件
 */
function handleKeydown(event: KeyboardEvent): void {
    if (!isVisible.value || event.defaultPrevented) return;

    switch (event.key) {
        case 'ArrowDown':
            if (hasSuggestions.value) {
                event.preventDefault();
                moveSuggestionDown();
            }
            break;
        case 'ArrowUp':
            if (hasSuggestions.value) {
                event.preventDefault();
                moveSuggestionUp();
            }
            break;
        case 'ArrowRight':
            tryCompleteQuery(event);
            break;
        case 'Tab':
            tryCompleteQuery(event);
            break;
        case 'Enter':
            event.preventDefault();
            if (activeSuggestionIndex.value >= 0 && suggestions.value[activeSuggestionIndex.value]) {
                const selected = selectActiveSuggestion();
                if (selected) {
                    selectSuggestion(selected);
                }
            } else if (canSearch.value) {
                submitSearch();
            }
            break;
        case 'Escape':
            if (hasSuggestions.value) {
                event.preventDefault();
                event.stopPropagation();
                clearSuggestions();
            }
            break;
    }
}

/**
 * 处理建议悬停
 */
function handleSuggestionHover(index: number): void {
    activeSuggestionIndex.value = index;
}

watch(
    () => props.modelValue,
    (visible) => {
        if (visible) {
            focusInput();
        } else {
            clearSuggestions();
        }
    }
);

const closeIconPath = 'M18 6L6 18M6 6l12 12';

// 注意：ModalOverlay 经 Teleport 渲染，scoped 样式命不中容器。
// 表面本身（底 / 圆角 / 阴影 / 模糊）由 ModalOverlay 的 glass-surface + elevation-3
// token 提供，这里只保留搜索面板必须的行为差异：
// 内容溢出可见，否则引擎下拉与搜索建议会被容器裁掉。
const modalContentStyle = {
    overflow: 'visible'
};

const modalBodyStyle = {
    padding: '0',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'visible'
};
</script>

<template>
    <!-- 不传 z-index：ModalOverlay 按打开顺序现算层序（--z-panel + 栈内序号 * --z-panel-step），
         所以 Cmd+K 面板永远压得住它下面已经开着的面板，不用管谁先渲染。 -->
    <ModalOverlay
        v-model="isVisible"
        :show-close="false"
        :size="size"
        :max-width="maxWidth"
        :close-on-overlay="true"
        :close-on-esc="!hasSuggestions"
        :lock-scroll="true"
        content-class="search-modal__content"
        :content-style="modalContentStyle"
        body-class="search-modal__body"
        :body-style="modalBodyStyle"
    >
        <div class="search-modal" @keydown="handleKeydown">
            <div class="search-modal__header">
                <div class="search-modal__bar">
                    <EngineSelector
                        :engines="engines"
                        :model-value="currentEngineIndex"
                        @update:model-value="handleEngineSelect"
                    />

                    <div class="search-modal__input-wrap">
                        <BaseInput
                            ref="inputRef"
                            v-model="query"
                            class="search-modal__input"
                            type="search"
                            :placeholder="placeholder"
                            autocomplete="off"
                            @keydown="handleKeydown"
                        />
                        <span
                            v-if="ghostSuffix"
                            class="search-modal__ghost"
                            aria-hidden="true"
                        ><span class="search-modal__ghost-query">{{ query }}</span><span class="search-modal__ghost-suffix">{{ ghostSuffix }}</span></span>
                    </div>

                    <button
                        type="button"
                        class="search-modal__submit"
                        aria-label="搜索"
                        @click="() => submitSearch()"
                    >
                        <IconSvg name="search" size="var(--icon-sm)" alt="" />
                    </button>
                </div>

                <button
                    type="button"
                    class="search-modal__close"
                    aria-label="关闭搜索"
                    @click="close"
                >
                    <IconSvg :path="closeIconPath" size="var(--icon-sm)" alt="" />
                </button>
            </div>

            <div class="search-modal__main">
                <SearchSuggestions
                    :suggestions="suggestions"
                    :active-index="activeSuggestionIndex"
                    :loading="isLoadingSuggestions"
                    :visible="showSuggestions"
                    :query="query"
                    @select="selectSuggestion"
                    @hover="handleSuggestionHover"
                />

                <SearchHistory
                    :history="history"
                    :visible="showHistory"
                    @select="handleHistorySelect"
                    @remove="removeHistory"
                    @clear="clearHistory"
                />

                <div v-if="showEmptyState" class="search-modal__empty">
                    <p class="search-modal__empty-title">搜索全网，一触即达</p>
                    <p class="search-modal__empty-text">输入关键词开始搜索，历史记录会显示在这里</p>
                </div>
            </div>

            <div class="search-modal__footer">
                <div class="search-modal__hints">
                    <span>
                        <kbd>↵</kbd>
                        搜索
                    </span>
                    <span>
                        <kbd>↑</kbd>
                        <kbd>↓</kbd>
                        选择
                    </span>
                    <span>
                        <kbd>→</kbd>
                        补全
                    </span>
                    <span>
                        <kbd>ESC</kbd>
                        关闭
                    </span>
                </div>
                <span v-if="currentEngine" class="search-modal__engine-name">
                    {{ currentEngine.name }}
                </span>
            </div>
        </div>
    </ModalOverlay>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.search-modal {
    display: flex;
    flex-direction: column;
    min-height: 0;

    &__body {
        padding: 0;
        display: flex;
        flex-direction: column;
        overflow: visible;
    }

    &__main {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        @include scrollable;
    }

    &__header {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4) var(--space-2);
    }

    // 胶囊搜索栏：引擎选择 + 输入 + 提交按钮整合为一体
    &__bar {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
        border-radius: var(--radius-lg);
        background: color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent);
        border: 1px solid transparent;
        @include md-transition(all, var(--md-transition-fast));

        &:focus-within {
            background: var(--glass-bg-strong);
            border-color: var(--md-sys-color-primary);
            box-shadow: 0 0 0 3px var(--tint-primary);
        }
    }

    &__input-wrap {
        position: relative;
        flex: 1;
        min-width: 0;
    }

    // 幽灵文本：镜像输入框的字体与内边距，仅展示补全后缀
    // 注意：与下方 __input 的 padding/font-size 联动，改动时需同步
    &__ghost {
        position: absolute;
        left: var(--space-1);
        top: 50%;
        transform: translateY(-50%);
        max-width: calc(100% - var(--space-3));
        overflow: hidden;
        font-size: var(--text-md);
        line-height: normal;
        white-space: pre;
        pointer-events: none;
        user-select: none;
    }

    &__ghost-query {
        visibility: hidden;
    }

    &__ghost-suffix {
        color: var(--md-sys-color-on-surface-variant);
        opacity: 0.55;
    }

    &__input {
        width: 100%;
        min-width: 0;

        :deep(.mnt-base-input__wrapper) {
            border: none;
            border-radius: var(--radius-md);
            padding: var(--space-2) var(--space-1);
            background: transparent;
            box-shadow: none;
        }

        :deep(.mnt-base-input__wrapper:focus-within) {
            box-shadow: none;
        }

        :deep(.mnt-base-input__field) {
            font-size: var(--text-md);

            // 焦点指示由 __bar 的 focus-within 光晕承担
            &:focus-visible {
                outline: none;
            }
        }
    }

    &__submit {
        @include button-reset;
        width: var(--control-h-md);
        height: var(--control-h-md);
        padding: 0;
        border-radius: var(--radius-sm);
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary);
        @include md-transition(all, var(--md-transition-fast));
        @include focus-ring;

        &:hover {
            opacity: 0.92;
            transform: translateY(-1px);
            box-shadow: var(--elevation-2);
        }

        &:active {
            transform: translateY(0);
        }

        &:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }

        // 边长交给模板上的 size="var(--icon-sm)"（IconSvg 内联样式），这里只管颜色
        .icon-svg {
            color: var(--md-sys-color-on-primary);
        }
    }

    &__close {
        @include button-reset;
        width: var(--control-h-md);
        height: var(--control-h-md);
        border-radius: var(--radius-full);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--md-sys-color-on-surface-variant);
        @include md-transition(all, var(--md-transition-fast));
        @include focus-ring;

        &:hover {
            background: var(--tint-error);
            color: var(--color-error);
        }
    }

    // 无历史记录时的空状态
    &__empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
        padding: var(--space-8) var(--space-6);
        text-align: center;
    }

    &__empty-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--weight-semibold);
        color: var(--md-sys-color-on-surface);
    }

    &__empty-text {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--md-sys-color-on-surface-variant);
        opacity: 0.8;
    }

    &__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-2) var(--space-4);
        background: transparent;
        font-size: var(--text-xs);
        color: var(--md-sys-color-on-surface-variant);
    }

    &__hints {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;

        span {
            display: flex;
            align-items: center;
            gap: var(--space-1);
        }

        kbd {
            min-width: 20px;
            padding: var(--space-1);
            border-radius: var(--radius-xs);
            font-family: monospace;
            font-size: var(--text-xs);
            text-align: center;
            background: var(--hover-bg);
            border: 1px solid var(--pressed-bg);
            border-bottom-width: 2px;
        }
    }

    &__engine-name {
        font-weight: var(--weight-semibold);
        color: var(--md-sys-color-primary);
    }
}

@include respond-to(mobile) {
    .search-modal__header {
        padding: var(--space-2) var(--space-3);
        gap: var(--space-1);
    }

    .search-modal__bar {
        padding-left: var(--space-2);
    }

    .search-modal__submit {
        width: var(--control-h-sm);
        height: var(--control-h-sm);
    }

    .search-modal__empty {
        padding: var(--space-6) var(--space-5);
    }

    .search-modal__footer {
        font-size: var(--text-xs);
        padding: var(--space-2) var(--space-3);
    }

    .search-modal__hints {
        gap: var(--space-2);
    }
}
</style>
