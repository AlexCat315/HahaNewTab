<script setup lang="ts">
/**
 * MinimalTileGrid - 极简约首页的分类胶囊 + 站点磁贴行
 *
 * 从 MinimalHome 拆出：这一块的交互自成一体（分类切换、展开/收起、长按菜单、
 * 拖拽排序），而「当前分类」「排序落盘」属于首页编排，所以按职责切开：
 * - 数据与写盘在首页（apps / activeCategoryId / reorder）
 * - 视图与手势在这里（展开态、拖拽态、长按计时都在本组件内）
 *
 * 根节点是 fragment：这些块直接充当首页居中列的 flex 子项，
 * 包一层 div 会改变 flex 布局，等于改了渲染结果。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { AppItem, Category } from '@/types/app';
import { isImageIcon } from '@/utils/image.util';
import IconSvg from '@/components/icon/IconSvg.vue';

/** 首屏磁贴数量（超出后需手动展开） */
const TILE_LIMIT = 16;

/** 触屏长按打开菜单的等待时长（毫秒） */
const LONG_PRESS_DURATION = 480;

/** 长按弹出菜单后，抑制随后的 click 事件的时长（毫秒） */
const CLICK_SUPPRESS_DURATION = 700;

export interface MinimalTileGridProps {
    /** 分类列表，用于顶部胶囊 */
    categories: Category[];
    /** 当前分类 id */
    activeCategoryId: string;
    /** 当前分类下用于展示的站点（已按揭示模式过滤） */
    apps: AppItem[];
    /** 是否处于隐藏站点揭示模式 */
    showHidden: boolean;
    /** 数据加载中 */
    isLoading: boolean;
    /** 当前分类下被隐藏的站点数 */
    hiddenCount: number;
}

const props = withDefaults(defineProps<MinimalTileGridProps>(), {
    showHidden: false,
    isLoading: false,
    hiddenCount: 0
});

const emit = defineEmits<{
    /** 切换分类 */
    (e: 'select-category', categoryId: string): void;
    /** 点击磁贴：由首页按 openMode 决定跳转方式 */
    (e: 'open-app', app: AppItem): void;
    /** 请求在指定视口坐标打开站点菜单 */
    (e: 'menu', app: AppItem, point: { clientX: number; clientY: number }): void;
    /** 开始拖拽：首页据此关闭可能开着的菜单 */
    (e: 'drag-start'): void;
    /** 拖拽后的新顺序（完整展示范围，首页负责写回全局顺序） */
    (e: 'reorder', orderedIds: string[]): void;
    (e: 'add-app'): void;
    (e: 'toggle-hidden-reveal'): void;
}>();

const showAll = ref(false);
/** 正在拖拽的站点 id */
const dragId = ref<string | null>(null);
/** 拖拽经过的目标索引 */
const dropIndex = ref<number | null>(null);

/** 长按计时器 */
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
/** 该时间戳之前忽略磁贴 click（长按菜单弹出后手指抬起会触发一次 click） */
let suppressClickUntil = 0;

const tiles = computed<AppItem[]>(() =>
    showAll.value ? props.apps : props.apps.slice(0, TILE_LIMIT)
);

const hasMore = computed(() => props.apps.length > TILE_LIMIT);

const isEmpty = computed(() => !props.isLoading && props.apps.length === 0);

function iconIsMonochrome(app: AppItem): boolean {
    const icon = app.icon?.trim();
    return !!icon && !isImageIcon(icon);
}

function toggleShowAll(): void {
    showAll.value = !showAll.value;
}

function handleTileClick(app: AppItem): void {
    // 长按刚弹出菜单时，手指抬起会补发一次 click，这里直接吞掉
    if (Date.now() < suppressClickUntil) return;
    emit('open-app', app);
}

/**
 * 请求首页弹出站点菜单。
 * 菜单一旦打开就作废待触发的长按计时，否则点「更多」时按下的那一下
 * 会在 480ms 后补弹一次菜单，触点还不一样。
 */
function requestMenu(app: AppItem, point: { clientX: number; clientY: number }): void {
    clearLongPress();
    emit('menu', app, { clientX: point.clientX, clientY: point.clientY });
}

function clearLongPress(): void {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}

/** 触屏长按打开菜单；鼠标交给 contextmenu 事件 */
function handleTilePointerDown(app: AppItem, event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;

    clearLongPress();
    const { clientX, clientY } = event;
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_DURATION;
        requestMenu(app, { clientX, clientY });
    }, LONG_PRESS_DURATION);
}

/** 「更多」按钮：把菜单挂在按钮右下角 */
function openMenuFromButton(app: AppItem, event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    requestMenu(app, {
        clientX: rect ? rect.left + rect.width : 0,
        clientY: rect ? rect.bottom + 4 : 0
    });
}

/** 键盘打开菜单（ContextMenu 键 / Shift+F10），锚定在磁贴中心 */
function handleTileKeydown(app: AppItem, event: KeyboardEvent): void {
    const isMenuKey =
        event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
    if (!isMenuKey) return;

    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    requestMenu(app, {
        clientX: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
        clientY: rect ? rect.top + rect.height / 2 : window.innerHeight / 2
    });
}

function handleDragStart(app: AppItem, event: DragEvent): void {
    clearLongPress();
    emit('drag-start');
    dragId.value = app.id;
    dropIndex.value = null;

    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        // Firefox 必须写入数据才会真正开始拖拽
        event.dataTransfer.setData('text/plain', app.id);
    }
}

function handleDragOver(index: number): void {
    if (!dragId.value) return;
    dropIndex.value = index;
}

function handleDragEnd(): void {
    dragId.value = null;
    dropIndex.value = null;
}

/**
 * 落下时只重排「当前可见的这一段」，超出首屏的站点保持原相对顺序跟在后面，
 * 交给首页把它合并回全局顺序。
 */
function handleDrop(index: number): void {
    const id = dragId.value;
    const target = tiles.value[index];
    dragId.value = null;
    dropIndex.value = null;

    if (!id || !target || target.id === id) return;

    const visibleIds = tiles.value
        .map((app) => app.id)
        .filter((itemId) => itemId !== id);
    const insertAt = visibleIds.indexOf(target.id);
    if (insertAt === -1) return;
    visibleIds.splice(insertAt, 0, id);

    const rest = props.apps
        .map((app) => app.id)
        .filter((itemId) => !visibleIds.includes(itemId));

    emit('reorder', [...visibleIds, ...rest]);
}

// 切换分类后收起展开态，避免停留在超长列表
watch(
    () => props.activeCategoryId,
    () => {
        showAll.value = false;
    }
);

onUnmounted(() => {
    clearLongPress();
});
</script>

<template>
    <nav v-if="categories.length > 1" class="minimal-chips" aria-label="分类">
        <button
            v-for="category in categories"
            :key="category.id"
            type="button"
            class="minimal-chips__item"
            :class="{ active: category.id === activeCategoryId }"
            @click="emit('select-category', category.id)"
        >
            {{ category.name }}
        </button>
    </nav>

    <section v-if="tiles.length > 0" class="minimal-tiles" aria-label="常用站点">
        <button
            v-for="(app, index) in tiles"
            :key="app.id"
            type="button"
            class="minimal-tile"
            :class="{
                'is-hidden': app.hidden,
                'is-dragging': dragId === app.id,
                'is-drop-target': dropIndex === index && !!dragId && dragId !== app.id,
            }"
            :data-app-id="app.id"
            :title="app.description || app.name"
            draggable="true"
            @click="handleTileClick(app)"
            @contextmenu.prevent="requestMenu(app, $event)"
            @keydown="handleTileKeydown(app, $event)"
            @pointerdown="handleTilePointerDown(app, $event)"
            @pointerup="clearLongPress"
            @pointercancel="clearLongPress"
            @pointerleave="clearLongPress"
            @dragstart="handleDragStart(app, $event)"
            @dragover.prevent="handleDragOver(index)"
            @drop.prevent="handleDrop(index)"
            @dragend="handleDragEnd"
        >
            <span class="minimal-tile__icon">
                <IconSvg
                    :src="app.icon"
                    name="site"
                    fallback="site"
                    size="var(--icon-xl)"
                    :monochrome="iconIsMonochrome(app)"
                    :alt="app.name"
                />
            </span>
            <span class="minimal-tile__name">{{ app.name }}</span>

            <span
                class="minimal-tile__more"
                role="button"
                tabindex="-1"
                title="更多操作"
                @click.stop="openMenuFromButton(app, $event)"
            >
                <IconSvg name="more" size="var(--icon-xs)" monochrome alt="" />
            </span>
        </button>
    </section>

    <p v-else-if="isLoading" class="minimal-hint">加载中…</p>
    <p v-else-if="isEmpty && hiddenCount > 0 && !showHidden" class="minimal-hint">
        当前分类下的 {{ hiddenCount }} 个站点都已隐藏
        <button type="button" class="minimal-hint__link" @click="emit('toggle-hidden-reveal')">
            显示它们
        </button>
    </p>
    <p v-else-if="isEmpty" class="minimal-hint">
        当前分类下还没有站点
        <button type="button" class="minimal-hint__link" @click="emit('add-app')">添加一个</button>
    </p>

    <button v-if="hasMore" type="button" class="minimal-more" @click="toggleShowAll">
        <IconSvg :name="showAll ? 'Fold' : 'arrow-down'" size="var(--icon-xs)" monochrome alt="" />
        <span>{{ showAll ? '收起' : `显示全部 ${apps.length} 个` }}</span>
    </button>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

// ==================== 分类胶囊 ====================
.minimal-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-1);
    margin-top: var(--space-5);
}

.minimal-chips__item {
    @include button-reset;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--md-sys-color-on-surface-variant);
    opacity: 0.55;
    @include md-transition(all, var(--md-transition-fast));

    &:hover {
        opacity: 0.9;
        background: var(--md-sys-color-surface-variant);
    }

    &.active {
        opacity: 1;
        background: var(--md-sys-color-primary-container);
        color: var(--md-sys-color-on-primary-container);
        font-weight: var(--weight-semibold);
    }
}

// ==================== 站点磁贴 ====================
.minimal-tiles {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-1) var(--tile-gap);
    margin-top: var(--space-6);
    width: 100%;
}

.minimal-tile {
    @include button-reset;
    position: relative;
    width: var(--tile-size);
    padding: var(--space-3) var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    @include md-transition(all, var(--md-transition-fast));
    @include focus-ring;

    &:hover {
        background: var(--md-sys-color-primary-container);

        .minimal-tile__more {
            opacity: 1;
        }
    }

    // 揭示模式下的隐藏站点：虚线 + 半透明，与完整模式保持一致
    &.is-hidden {
        opacity: 0.55;

        .minimal-tile__icon {
            border: 1px dashed var(--card-border);
        }
    }

    // 拖拽中：原地留一个淡出占位，避免布局跳动
    &.is-dragging {
        opacity: 0.35;
    }

    // 拖拽经过的目标：左侧插入指示线
    &.is-drop-target::before {
        content: '';
        position: absolute;
        left: 0;
        top: 10%;
        bottom: 10%;
        width: 2px;
        border-radius: var(--radius-full);
        background: var(--md-sys-color-primary);
    }
}

// 图标底板 = 磁贴图标档 + 四周各 --space-1 的内衬，跟着图标尺寸一起缩放
.minimal-tile__icon {
    width: calc(var(--tile-icon-size) + var(--space-1) * 2);
    height: calc(var(--tile-icon-size) + var(--space-1) * 2);
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
    background: var(--hover-bg);
}

.minimal-tile__name {
    max-width: 100%;
    font-size: var(--text-xs);
    line-height: var(--leading-tight);
    color: var(--md-sys-color-on-surface);
    text-align: center;
    @include line-clamp(2);
}

.minimal-tile__more {
    position: absolute;
    top: var(--space-1);
    right: var(--space-1);
    width: var(--icon-sm);
    height: var(--icon-sm);
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--glass-bg-opaque);
    border: 1px solid var(--card-border);
    color: var(--md-sys-color-on-surface-variant);
    opacity: 0;
    @include md-transition(opacity, var(--md-transition-fast));

    &:hover {
        background: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary);
        border-color: transparent;
    }
}

// ==================== 辅助文案 ====================
.minimal-hint {
    margin: var(--space-6) 0 0;
    font-size: var(--text-sm);
    color: var(--md-sys-color-on-surface-variant);
    opacity: 0.6;
}

.minimal-hint__link {
    @include button-reset;
    color: var(--md-sys-color-primary);
    text-decoration: underline;
    margin-left: var(--space-1);
}

.minimal-more {
    @include button-reset;
    margin-top: var(--space-6);
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--md-sys-color-on-surface-variant);
    opacity: 0.6;
    @include md-transition(all, var(--md-transition-fast));

    &:hover {
        opacity: 1;
        background: var(--md-sys-color-surface-variant);
    }
}

@include respond-to(mobile) {
    // 窄屏一屏要装下更多列，磁贴按间距阶收一档
    .minimal-tile {
        width: calc(var(--tile-size) - var(--space-3));
    }
}
</style>
