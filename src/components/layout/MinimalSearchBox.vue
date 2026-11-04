<script setup lang="ts">
/**
 * MinimalSearchBox - 极简约首页的居中搜索框
 *
 * 从 MinimalHome 拆出：useSearch 状态、引擎切换与建议面板只服务这一块，
 * 留在首页里会把「页面编排」和「搜索实现」揉进同一个千行组件。
 *
 * 对外只暴露两个动作，编排仍归首页：
 * - focusInput：进入页面「打开即可打字」（首页挂载后延时调用）
 * - clearSuggestions：点击搜索区之外时收起建议（监听挂在首页根节点上）
 *
 * 引擎选择与完整搜索弹窗共用 search.store，所以这里切换会同步到 SearchModal。
 */
import { computed, nextTick, ref } from 'vue';
import { useSearch } from '@/composables/useSearch';
import IconSvg from '@/components/icon/IconSvg.vue';
import SearchSuggestions from '@/components/search/SearchSuggestions.vue';
import EngineSelector from '@/components/search/EngineSelector.vue';

// 极简页一屏只放一个搜索框，防抖更短、建议条数更少，避免联想面板压住下方磁贴
const {
    query,
    engines,
    currentEngineIndex,
    suggestions,
    activeSuggestionIndex,
    isLoadingSuggestions,
    hasSuggestions,
    canSearch,
    currentEngine,
    executeSearch,
    executeSearchWithSuggestion,
    clearSuggestions,
    moveSuggestionDown,
    moveSuggestionUp,
    selectActiveSuggestion,
    selectEngine
} = useSearch({ debounceMs: 180, maxSuggestions: 8, maxLocalSuggestions: 4 });

const inputEl = ref<HTMLInputElement | null>(null);

/** 占位文案跟随当前搜索引擎，句式对齐浏览器原生新标签页 */
const searchPlaceholder = computed(
    () => `在 ${currentEngine.value?.name ?? '网页'} 中搜索，或输入网址`
);

function focusInput(): void {
    nextTick(() => {
        inputEl.value?.focus();
        inputEl.value?.select();
    });
}

async function submitSearch(rawQuery?: string): Promise<void> {
    await executeSearch(rawQuery);
}

/**
 * 切换搜索引擎后把焦点交还输入框，方便直接接着打字。
 * selectEngine 落到 useSearch → search.store，与 SearchModal 共用同一份持久化状态。
 */
async function handleEngineSelect(payload: { index: number }): Promise<void> {
    await selectEngine(payload.index);
    focusInput();
}

function handleInputKeydown(event: KeyboardEvent): void {
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
        case 'Enter': {
            event.preventDefault();
            if (activeSuggestionIndex.value >= 0 && suggestions.value[activeSuggestionIndex.value]) {
                const selected = selectActiveSuggestion();
                if (selected) {
                    void executeSearchWithSuggestion(selected);
                    return;
                }
            }
            if (canSearch.value) {
                void submitSearch();
            }
            break;
        }
        case 'Escape':
            if (query.value) {
                event.preventDefault();
                query.value = '';
                clearSuggestions();
            }
            break;
    }
}

defineExpose({ focusInput, clearSuggestions });
</script>

<template>
    <div class="minimal-search">
        <div class="minimal-search__box">
            <EngineSelector
                class="minimal-search__engine-selector"
                :engines="engines"
                :model-value="currentEngineIndex"
                @select="handleEngineSelect"
            />

            <span class="minimal-search__divider" aria-hidden="true" />

            <input
                ref="inputEl"
                v-model="query"
                class="minimal-search__input"
                type="text"
                :placeholder="searchPlaceholder"
                autocomplete="off"
                spellcheck="false"
                aria-label="搜索"
                @keydown="handleInputKeydown"
            />

            <button
                type="button"
                class="minimal-search__submit"
                title="搜索"
                :disabled="!canSearch"
                @click="submitSearch()"
            >
                <IconSvg name="search" size="var(--icon-sm)" monochrome alt="" />
            </button>
        </div>

        <div v-show="hasSuggestions || isLoadingSuggestions" class="minimal-search__panel">
            <SearchSuggestions
                :suggestions="suggestions"
                :active-index="activeSuggestionIndex"
                :loading="isLoadingSuggestions"
                :visible="hasSuggestions"
                :query="query"
                @select="executeSearchWithSuggestion"
            />
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.minimal-search {
    position: relative;
    // 高于磁贴行，确保引擎下拉 / 搜索建议向下展开时盖住磁贴而非被磁贴盖住
    z-index: var(--z-dropdown);
    width: 100%;
    max-width: var(--search-max-width);
}

.minimal-search__box {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--search-box-height);
    padding: 0 var(--space-2);
    // 压在壁纸上的输入外壳：玻璃底 + 模糊 + 描边由混入给全
    @include glass-surface(var(--glass-bg-strong), var(--radius-full));
    @include spring-transition(all, var(--dur-fast));

    &:focus-within {
        background: var(--glass-bg-opaque);
        box-shadow: var(--elevation-2), 0 0 0 4px var(--focus-ring);
    }
}

// 左侧搜索引擎选择器（复用 EngineSelector）：只调外观，类名与 DOM 归子组件所有
.minimal-search__engine-selector {
    :deep(.engine-selector__trigger) {
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
        color: var(--label-secondary);

        &:hover:not(:disabled) {
            background: var(--fill);
            color: var(--label);
        }
    }

    // 引擎名再长就省略：超过这个宽度会把输入框挤成一条缝。
    // 尺寸语言里没有「行内标签列宽」这一档，故保留字面量（已上报缺 token）。
    :deep(.engine-selector__name) {
        max-width: 88px;
    }

    :deep(.engine-selector__dropdown) {
        top: calc(100% + var(--space-4));
        left: 0;
        // 下拉属于轻浮层，走菜单/Toast 那一档宽度而不是面板档
        min-width: var(--pop-w-min);
    }
}

.minimal-search__divider {
    flex-shrink: 0;
    width: 1px;
    // 20px 正好是图标 sm 档，分隔线取同一高度才能和两侧图标对齐
    height: var(--space-5);
    background: var(--card-border);
}

// 右侧搜索按钮（与浏览器原生新标签页一致：放大镜在右）
.minimal-search__submit {
    @include button-reset;
    flex-shrink: 0;
    width: var(--control-h-sm);
    height: var(--control-h-sm);
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--label-secondary);
    opacity: 0.75;
    @include spring-transition(all, var(--dur-fast));

    &:hover:not(:disabled) {
        opacity: 1;
        color: var(--label);
        background: var(--fill-secondary);
    }

    &:disabled {
        opacity: 0.3;
        cursor: default;
    }
}

.minimal-search__input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-family: inherit;
    font-size: var(--text-md);
    color: var(--label);

    &::placeholder {
        color: var(--label-secondary);
        opacity: 0.6;
    }
}

.minimal-search__panel {
    position: absolute;
    top: calc(100% + var(--space-2));
    left: 0;
    right: 0;
    padding: var(--space-1);
    @include glass-surface(var(--glass-bg-opaque), var(--radius-xl));
    box-shadow: var(--elevation-3);
    z-index: var(--z-dropdown);
}

// 触屏键盘会占掉半屏，输入外壳收成控件 lg 档，避免搜索框吃掉可视区
@include respond-to(mobile) {
    .minimal-search__box {
        height: var(--control-h-lg);
        padding: 0 var(--space-3);
    }
}
</style>
