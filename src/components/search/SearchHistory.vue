<script setup lang="ts">
/**
 * SearchHistory - 搜索历史列表
 *
 * 展示最近的搜索关键词，支持点击复用、单条删除与全部清空。
 * 每条历史显示搜索时间（相对时间），整体布局更紧凑。
 */
import { computed } from 'vue';
import IconSvg from '@/components/icon/IconSvg.vue';
import type { SearchHistoryItem } from '@/stores/search.store';

export interface SearchHistoryProps {
    /** 搜索历史列表 */
    history: SearchHistoryItem[];
    /** 是否显示 */
    visible?: boolean;
    /** 最大高度 */
    maxHeight?: string | number;
    /** 空状态提示 */
    emptyText?: string;
    /** 标题 */
    title?: string;
}

const props = withDefaults(defineProps<SearchHistoryProps>(), {
    visible: true,
    maxHeight: 260,
    emptyText: '暂无搜索历史',
    title: '最近搜索'
});

const emit = defineEmits<{
    (e: 'select', query: string): void;
    (e: 'remove', query: string): void;
    (e: 'clear'): void;
}>();

const contentStyle = computed(() => {
    const height = typeof props.maxHeight === 'number' ? `${props.maxHeight}px` : props.maxHeight;
    return { maxHeight: height };
});

function handleSelect(query: string): void {
    emit('select', query);
}

function handleRemove(query: string, event: Event): void {
    event.stopPropagation();
    emit('remove', query);
}

function handleClear(): void {
    emit('clear');
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function formatAbsoluteTime(time: number): string {
    const date = new Date(time);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelativeTime(time: number): string {
    const diff = Date.now() - time;
    const seconds = Math.floor(diff / 1000);

    if (seconds < 60) {
        return '刚刚';
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} 分钟前`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} 小时前`;
    }

    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days} 天前`;
    }

    return formatAbsoluteTime(time);
}

const deleteIconPath = 'M18 6L6 18M6 6l12 12';
</script>

<template>
    <div
        v-if="visible && history.length > 0"
        class="search-history"
        :style="contentStyle"
    >
        <div class="search-history__header">
            <span class="search-history__title">{{ title }}</span>
            <button
                type="button"
                class="search-history__clear"
                :aria-label="`清空${title}`"
                @click="handleClear"
            >
                清空
            </button>
        </div>

        <div class="search-history__list" role="list">
            <button
                v-for="(item, index) in history"
                :key="`${item.query}-${index}`"
                type="button"
                class="search-history__item"
                role="listitem"
                :title="formatAbsoluteTime(item.time)"
                @click="handleSelect(item.query)"
            >
                <slot name="item" :query="item.query" :index="index" :time="item.time">
                    <span class="search-history__item-icon">
                        <IconSvg name="history" size="var(--icon-xs)" alt="" monochrome />
                    </span>
                    <span class="search-history__item-text">{{ item.query }}</span>
                    <span class="search-history__item-time">{{ formatRelativeTime(item.time) }}</span>
                    <span
                        class="search-history__item-remove"
                        role="button"
                        tabindex="0"
                        :aria-label="`删除 ${item.query}`"
                        @click="handleRemove(item.query, $event)"
                        @keydown.enter.stop="handleRemove(item.query, $event)"
                    >
                        <IconSvg :path="deleteIconPath" size="var(--icon-xs)" alt="" />
                    </span>
                </slot>
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.search-history {
    background: transparent;
    @include scrollable;

    &__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-2) var(--space-3);
    }

    &__title {
        @include section-label;
    }

    &__clear {
        @include button-reset;
        color: var(--label-secondary);
        font-size: var(--text-xs);
        font-weight: var(--weight-semibold);
        @include spring-transition(color, var(--dur-fast));
        @include focus-ring;

        &:hover {
            color: var(--color-error);
        }
    }

    &__list {
        padding: var(--space-1) var(--space-2);
    }

    &__item {
        @include button-reset;
        position: relative;
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

        // 历史行没有「当前选中项」这一层（键盘导航走建议列表），所以只到中性悬停档，
        // 不上主色底——上主色会让「鼠标扫过」看起来像已经选中过这条搜索。
        // 图标底板跟着往上一档（--pressed-bg），否则和行底同色就直接消失了。
        &:hover,
        &:focus-visible {
            background: var(--hover-bg);

            .search-history__item-icon {
                background: var(--pressed-bg);
            }

            .search-history__item-time {
                opacity: 0;
            }

            .search-history__item-remove {
                opacity: 1;
                pointer-events: auto;
            }
        }
    }

    &__item-icon {
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

    &__item-text {
        @include text-ellipsis;
        flex: 1;
        min-width: 0;
    }

    &__item-time {
        flex-shrink: 0;
        font-size: var(--text-xs);
        color: var(--label-secondary);
        opacity: 0.7;
        @include spring-transition(opacity, var(--dur-fast));
    }

    &__item-remove {
        position: absolute;
        right: var(--space-2);
        top: 50%;
        transform: translateY(-50%);
        width: var(--control-h-xs);
        height: var(--control-h-xs);
        border-radius: var(--radius-xs);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        color: var(--label-secondary);
        background: var(--glass-bg-opaque);
        @include spring-transition(all, var(--dur-fast));

        &:hover {
            background: var(--tint-error);
            color: var(--color-error);
        }

        &:focus-visible {
            opacity: 1;
            pointer-events: auto;
            background: var(--tint-error);
            color: var(--color-error);
        }
    }
}

@include respond-to(mobile) {
    .search-history__item-remove {
        opacity: 1;
        pointer-events: auto;
        background: transparent;
    }

    .search-history__item-time {
        display: none;
    }
}
</style>
