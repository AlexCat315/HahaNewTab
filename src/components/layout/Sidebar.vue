<script setup lang="ts">
/**
 * Sidebar - 分类导航 rail
 *
 * 浮在壁纸左侧的一块半透明圆角浮层，与顶栏同一套表面语言。
 * 展开态显示分类名与该分类的站点数，折叠态收成图标 rail（hover 出名称提示），
 * 移动端转为抽屉。分类拖拽排序与全局搜索入口都在这一层。
 * 当未传入 categories 时，会尝试从 useDataManager 初始化并读取分类数据。
 */
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    watch
} from 'vue';
import type { Category } from '@/types/app';
import { useDataManager } from '@/composables/useDataManager';
import { useDragSort } from '@/composables/useDragSort';
import IconSvg from '@/components/icon/IconSvg.vue';

export interface SidebarProps {
    /** 分类列表；未传入时从 useDataManager 读取 */
    categories?: Category[];
    /** 当前选中分类 ID */
    activeCategoryId?: string;
    /** 是否折叠 */
    collapsed?: boolean;
    /** 移动端是否打开 */
    mobileOpen?: boolean;
    /** 是否启用分类拖拽排序 */
    enableDragSort?: boolean;
    /** 各分类的可见站点数；传入时在分类名右侧显示 */
    counts?: Record<string, number>;
}

const props = withDefaults(defineProps<SidebarProps>(), {
    categories: undefined,
    activeCategoryId: 'all',
    collapsed: false,
    mobileOpen: false,
    enableDragSort: true,
    counts: undefined
});

const emit = defineEmits<{
    (e: 'select-category', categoryId: string): void;
    (e: 'update:mobileOpen', value: boolean): void;
    (e: 'open-search'): void;
    (e: 'order-change', orderedIds: string[]): void;
}>();

const dataManager = useDataManager({ autoInit: false });

const displayedCategories = computed(() => props.categories ?? dataManager.categories.value);

const menuRef = ref<HTMLElement | null>(null);
const suppressClick = ref(false);
let suppressTimer: ReturnType<typeof setTimeout> | null = null;

const dragDisabled = computed(() => !props.enableDragSort || props.collapsed);

const { isDragging, isPressing, currentId } = useDragSort({
    containerRef: menuRef,
    itemSelector: '.nav-item[data-draggable="true"]',
    direction: 'vertical',
    disabled: dragDisabled,
    canDrag: (element) => element.dataset.draggable === 'true',
    onEnd: (event) => {
        if (!menuRef.value || event.cancelled) {
            return;
        }

        // 拖拽过程中 DOM 已被实时重排，直接按 DOM 顺序提交
        const orderedIds = Array.from(
            menuRef.value.querySelectorAll<HTMLElement>('.nav-item[data-draggable="true"]')
        )
            .map((element) => element.dataset.id)
            .filter((id): id is string => !!id);

        const currentOrder = displayedCategories.value
            .filter((category) => category.id !== 'all')
            .map((category) => category.id);

        // 顺序未变化时不触发保存
        if (orderedIds.join('\0') === currentOrder.join('\0')) {
            return;
        }

        emit('order-change', orderedIds);

        suppressClick.value = true;
        if (suppressTimer) {
            clearTimeout(suppressTimer);
        }
        suppressTimer = setTimeout(() => {
            suppressClick.value = false;
        }, 100);
    }
});

onMounted(() => {
    if (props.categories === undefined) {
        dataManager.init().catch((error) => {
            console.error('[Sidebar] 初始化数据失败:', error);
        });
    }
});

onUnmounted(() => {
    if (suppressTimer) {
        clearTimeout(suppressTimer);
    }
});

function isDraggable(category: Category): boolean {
    return category.id !== 'all';
}

function handleCategoryClick(category: Category): void {
    if (suppressClick.value || isDragging.value) {
        return;
    }
    emit('select-category', category.id);
}

function handleSearchClick(): void {
    emit('open-search');
}

function handleOverlayClick(): void {
    emit('update:mobileOpen', false);
}

watch(
    () => props.mobileOpen,
    (open) => {
        if (open) {
            nextTick(() => {
                const activeItem = menuRef.value?.querySelector('.nav-item.active') as HTMLElement | null;
                activeItem?.scrollIntoView({ block: 'nearest' });
            });
        }
    }
);
</script>

<template>
    <aside
        class="sidebar"
        :class="{ collapsed: collapsed, open: mobileOpen }"
        :aria-hidden="mobileOpen ? undefined : 'true'"
    >
        <div ref="menuRef" class="nav-menu">
            <slot name="header" />

            <button
                v-for="category in displayedCategories"
                :key="category.id"
                type="button"
                class="nav-item"
                :class="{
                    active: category.id === activeCategoryId,
                    pressing: isPressing && currentId === category.id,
                    dragging: isDragging && currentId === category.id
                }"
                :data-id="category.id"
                :data-title="category.name"
                :data-draggable="isDraggable(category)"
                :aria-current="category.id === activeCategoryId ? 'page' : undefined"
                @click="handleCategoryClick(category)"
            >
                <span class="nav-icon">
                    <IconSvg
                        :src="category.icon"
                        size="var(--icon-sm)"
                        :monochrome="category.monochrome"
                        :alt="category.name"
                    />
                </span>
                <span class="nav-text">{{ category.name }}</span>
                <span v-if="counts" class="nav-count">{{ counts[category.id] ?? 0 }}</span>
            </button>

            <slot name="footer" />
        </div>

        <div class="sidebar-footer">
            <button
                type="button"
                class="search-nav-item"
                title="全局搜索 (Ctrl+K)"
                @click="handleSearchClick"
            >
                <span class="nav-icon">
                    <IconSvg name="search" size="var(--icon-sm)" monochrome />
                </span>
                <span class="nav-text">全局搜索</span>
                <kbd v-if="!collapsed" class="search-shortcut">Ctrl K</kbd>
            </button>
        </div>
    </aside>

    <div
        v-if="mobileOpen"
        class="sidebar-overlay"
        @click="handleOverlayClick"
    />
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.sidebar {
    position: fixed;
    left: var(--shell-inset);
    top: calc(var(--header-height) + var(--shell-inset) * 2);
    bottom: var(--shell-inset);
    width: var(--sidebar-width);
    @include glass-surface(var(--glass-bg), var(--shell-radius));
    z-index: var(--z-rail);
    display: flex;
    flex-direction: column;
    contain: layout;
    @include spring-transition(width);
}

.nav-menu {
    padding: var(--space-3) var(--space-2);
    flex: 1;
    @include scrollable;
}

.nav-item {
    @include button-reset;
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    // rail 行是可点控件，热区取控件默认档
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    margin-bottom: var(--space-1);
    border-radius: var(--radius-md);
    color: var(--label-secondary);
    font-weight: var(--weight-medium);
    font-size: var(--text-base);
    position: relative;
    white-space: nowrap;
    user-select: none;
    @include spring-transition(background color, var(--dur-fast));

    &:hover {
        background: var(--hover-bg);
        color: var(--label);
    }

    // macOS 侧栏的选中行是「强调色实底 + 反白」，不是淡 tint：
    // rail 只有一个当前项，实底才读得出「你在这」。on-accent 由主题配套给出，
    // 明暗两套的对比度都在 gen-themes 里校验过。
    &.active {
        @include accent-fill;
        font-weight: var(--weight-semibold);
    }

    &.pressing {
        background: var(--fill);
    }

    &.dragging {
        opacity: 0.6;
        background: var(--fill);
        box-shadow: var(--elevation-2);
        cursor: grabbing;
        // 只需压过同级的分类项，不必压过弹层——与应用卡拖拽态取同一档
        z-index: var(--z-dropdown);
    }

    &[data-draggable='true'] {
        cursor: grab;
    }

    &[data-draggable='false'] {
        cursor: pointer;
    }
}

.nav-icon {
    width: var(--icon-sm);
    height: var(--icon-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.nav-text {
    flex: 1;
    min-width: 0;
    @include text-ellipsis;
}

.nav-count {
    flex-shrink: 0;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--label-secondary);
    font-variant-numeric: tabular-nums;
    opacity: 0.75;

    .nav-item.active & {
        opacity: 1;
    }
}

.sidebar-footer {
    padding: var(--space-3) var(--space-2);
    border-top: 1px solid var(--glass-border);
    flex-shrink: 0;
}

.search-nav-item {
    @include button-reset;
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    // 与分类行同一档热区，两个入口才不会被看出两种高度
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    color: var(--label);
    background: var(--fill);
    font-weight: var(--weight-medium);
    font-size: var(--text-base);
    @include spring-transition(background color transform, var(--dur-fast));

    &:hover {
        background: var(--fill-secondary);
        color: var(--label);
    }
}

.search-shortcut {
    margin-left: auto;
    font-size: var(--text-xs);
    font-family: inherit;
    opacity: 0.7;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-xs);
    border: 1px solid var(--glass-border);
    background: var(--hover-bg);
    white-space: nowrap;
}

// ==================== 折叠态：图标 rail ====================
.sidebar.collapsed {
    width: var(--sidebar-collapsed-width);

    .nav-item,
    .search-nav-item {
        justify-content: center;
        padding: 0;
    }

    .nav-text,
    .nav-count {
        display: none;
    }

    // 折叠后看不见分类名，hover 时在右侧浮出名称
    .nav-item:hover::after {
        content: attr(data-title);
        position: absolute;
        left: calc(100% + var(--space-3));
        top: 50%;
        transform: translateY(-50%);
        background: var(--tooltip-bg);
        color: var(--tooltip-fg);
        padding: var(--space-1) var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        white-space: nowrap;
        z-index: var(--z-dropdown);
        box-shadow: var(--elevation-2);
        pointer-events: none;
    }
}

.sidebar-overlay {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    z-index: calc(var(--z-rail) - 1);
}

@include respond-to(mobile) {
    .sidebar {
        top: 0;
        bottom: 0;
        left: 0;
        width: var(--sidebar-width);
        // 抽屉贴住视口左缘：只把左缘两角归零，右缘保留基础规则的 --radius-xl
        border-start-start-radius: 0;
        border-end-start-radius: 0;
        transform: translateX(-100%);
        transition: transform var(--dur-med) var(--ease-spring);

        &.open {
            transform: translateX(0);
        }
    }

    // 抽屉永远是展开态：触屏没有 hover，收起态的文字必须照常显示
    .sidebar.collapsed {
        width: var(--sidebar-width);

        .nav-item,
        .search-nav-item {
            justify-content: flex-start;
            padding: 0 var(--space-3);
        }

        .nav-text,
        .nav-count {
            display: block;
        }

        .nav-item:hover::after {
            display: none;
        }
    }
}
</style>
