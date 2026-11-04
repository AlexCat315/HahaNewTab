<script setup lang="ts">
/**
 * SearchSuggestions - 搜索建议列表
 *
 * 展示本地历史 + 远程搜索引擎返回的关键词补全建议，支持高亮当前项、
 * 鼠标悬停与键盘上下键导航（循环跳转时高亮项自动滚动到可见区域）。
 *
 * 加载表现（配合 useSearch 的 SWR 策略）：
 * - 已有建议时刷新：列表半透明过渡，不清空，避免高度跳变；
 * - 无建议时加载：显示骨架屏占位。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { escapeHtml } from '@/utils/escape.util';
import IconSvg from '@/components/icon/IconSvg.vue';

export interface SearchSuggestionsProps {
    /** 建议列表 */
    suggestions: string[];
    /** 当前高亮索引，-1 表示未选中 */
    activeIndex?: number;
    /** 是否正在加载远程建议 */
    loading?: boolean;
    /** 是否显示 */
    visible?: boolean;
    /** 当前输入关键词，用于高亮匹配部分 */
    query?: string;
    /** 最大高度 */
    maxHeight?: string | number;
    /** 空状态提示 */
    emptyText?: string;
}

const props = withDefaults(defineProps<SearchSuggestionsProps>(), {
    activeIndex: -1,
    loading: false,
    visible: true,
    query: '',
    maxHeight: 240,
    emptyText: '暂无搜索建议'
});

const emit = defineEmits<{
    (e: 'select', suggestion: string): void;
    (e: 'hover', index: number): void;
}>();

const hasSuggestions = computed(() => props.suggestions.length > 0);
const shouldShow = computed(() => props.visible && (hasSuggestions.value || props.loading));
/** 刷新中：已有旧建议，等待新结果替换（保持列表不清空） */
const isRefreshing = computed(() => props.loading && hasSuggestions.value);

const contentStyle = computed(() => {
    const height = typeof props.maxHeight === 'number' ? `${props.maxHeight}px` : props.maxHeight;
    return { maxHeight: height };
});

/** 骨架屏文本条宽度（制造错落感） */
const skeletonWidths = ['52%', '74%', '61%'];

/** 建议列表容器（用于高亮项跟随滚动） */
const listRef = ref<HTMLElement | null>(null);

// 高亮项变化时滚动到可见区域（含循环跳转后回滚到顶部/底部）
watch(
    () => props.activeIndex,
    (index) => {
        if (index < 0) {
            return;
        }
        nextTick(() => {
            const items = listRef.value?.querySelectorAll('.search-suggestions__item');
            (items?.[index] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
        });
    }
);

function handleSelect(suggestion: string): void {
    emit('select', suggestion);
}

function handleHover(index: number): void {
    emit('hover', index);
}

/**
 * 高亮建议中与查询词匹配的部分
 * 返回安全的 HTML 字符串，使用 v-html 渲染。
 */
function highlightMatch(suggestion: string): string {
    const query = props.query.trim();
    if (!query) {
        return escapeHtml(suggestion);
    }

    const lowerSuggestion = suggestion.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerSuggestion.indexOf(lowerQuery);

    if (index === -1) {
        return escapeHtml(suggestion);
    }

    const before = escapeHtml(suggestion.slice(0, index));
    const match = escapeHtml(suggestion.slice(index, index + query.length));
    const after = escapeHtml(suggestion.slice(index + query.length));

    return `${before}<mark class="search-suggestions__mark">${match}</mark>${after}`;
}
</script>

<template>
    <div
        v-show="shouldShow"
        class="search-suggestions"
        :class="{ 'is-refreshing': isRefreshing }"
        :style="contentStyle"
        role="listbox"
        aria-label="搜索建议"
    >
        <div
            v-if="loading && !hasSuggestions"
            class="search-suggestions__skeleton"
            aria-hidden="true"
        >
            <div
                v-for="(width, index) in skeletonWidths"
                :key="index"
                class="search-suggestions__skeleton-item"
            >
                <span class="search-suggestions__skeleton-icon" />
                <span class="search-suggestions__skeleton-text" :style="{ width }" />
            </div>
        </div>

        <div
            v-else-if="hasSuggestions"
            ref="listRef"
            class="search-suggestions__list"
        >
            <button
                v-for="(suggestion, index) in suggestions"
                :key="`${suggestion}-${index}`"
                type="button"
                class="search-suggestions__item"
                :class="{ 'is-active': index === activeIndex }"
                role="option"
                :aria-selected="index === activeIndex"
                @click="handleSelect(suggestion)"
                @mouseenter="handleHover(index)"
            >
                <slot
                    name="item"
                    :suggestion="suggestion"
                    :index="index"
                    :active="index === activeIndex"
                    :query="query"
                    :highlight="highlightMatch(suggestion)"
                >
                    <span class="search-suggestions__icon">
                        <IconSvg name="search" size="var(--icon-xs)" alt="" monochrome />
                    </span>
                    <span
                        class="search-suggestions__text"
                        v-html="highlightMatch(suggestion)"
                    />
                </slot>
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.search-suggestions {
    overflow-y: auto;
    background: transparent;
    @include scrollable;

    &__skeleton {
        padding: var(--space-1) var(--space-2) var(--space-3);
    }

    &__skeleton-item {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
    }

    &__skeleton-icon,
    &__skeleton-text {
        background: linear-gradient(
            90deg,
            var(--fill-tertiary) 25%,
            var(--fill-secondary) 50%,
            var(--fill-tertiary) 75%
        );
        background-size: 200% 100%;
        animation: mnt-skeleton-shimmer 1.4s ease infinite;
    }

    &__skeleton-icon {
        width: var(--icon-md);
        height: var(--icon-md);
        border-radius: var(--radius-full);
        flex-shrink: 0;
    }

    &__skeleton-text {
        height: 14px;
        border-radius: var(--radius-sm);
    }

    &__list {
        padding: var(--space-1) var(--space-2) var(--space-3);
        @include spring-transition(opacity, var(--dur-fast));
        // 骨架换成真实列表时淡入，避免硬切
        animation: mnt-suggestions-in 0.16s ease;
    }

    // 刷新中：旧列表保持显示，半透明提示正在更新，避免高度跳变
    &.is-refreshing &__list {
        opacity: 0.55;
    }

    &__item {
        @include button-reset;
        width: 100%;
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2);
        border-radius: var(--radius-md);
        color: var(--label);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        text-align: left;
        @include spring-transition(all, var(--dur-fast));
        @include focus-ring;

        // 列表行的交互语言与全应用一致：悬停只加中性底，当前项上强调色实底 + 反白
        // （macOS 菜单的键盘高亮就是实底，淡 tint 在一列密集行里读不出「是哪一行」）。
        &:hover {
            background: var(--hover-bg);
        }

        &.is-active {
            @include accent-fill;
            font-weight: var(--weight-semibold);

            .search-suggestions__icon {
                background: color-mix(in srgb, var(--on-accent) 24%, transparent);
                color: var(--on-accent);
            }
        }
    }

    &__icon {
        width: var(--icon-md);
        height: var(--icon-md);
        border-radius: var(--radius-full);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        background: var(--hover-bg);
        @include spring-transition(all, var(--dur-fast));
    }

    &__text {
        @include text-ellipsis;
        flex: 1;

        // 命中片段：字重只到 --weight-semibold（阶梯顶），所以主色必须一起上才读得出强调。
        // 左右留 --space-1：选中态给命中处垫底色时，行内文本宽度不随状态变化。
        :deep(mark) {
            background: transparent;
            color: var(--accent);
            font-weight: var(--weight-semibold);
            padding: 0 var(--space-1);
            border-radius: var(--radius-xs);
        }

        // 选中行整行都是主色，命中片段单靠字重和颜色已经顶不出来，垫一档深主色底
        .is-active & :deep(mark) {
            background: var(--tint-primary-strong);
        }
    }
}

@keyframes mnt-skeleton-shimmer {
    from {
        background-position: 200% 0;
    }

    to {
        background-position: -200% 0;
    }
}

@keyframes mnt-suggestions-in {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}

@include respond-to(mobile) {
    .search-suggestions__item {
        padding: var(--space-2) var(--space-3);
        font-size: var(--text-md);
    }
}
</style>
