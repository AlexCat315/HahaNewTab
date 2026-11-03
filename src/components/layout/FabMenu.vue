<script setup lang="ts">
/**
 * FabMenu - 浮动操作按钮菜单
 *
 * 提供常驻 FAB 按钮与弹出式菜单，支持普通操作项、分隔线与分组标题。
 * 可通过 v-model:active 控制展开状态，也支持点击外部自动关闭。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import IconSvg from '@/components/icon/IconSvg.vue';

export interface FabMenuItem {
    /** 操作项唯一标识 */
    action?: string;
    /** 显示文本 */
    label?: string;
    /** 系统图标名称 */
    icon?: string;
    /** 是否为分隔线 */
    divider?: boolean;
    /** 分组标题 */
    section?: string;
}

export interface FabMenuProps {
    /** 菜单项列表 */
    items: FabMenuItem[];
    /** FAB 主按钮图标 */
    mainIcon?: string;
    /** 是否展开，支持 v-model:active */
    active?: boolean;
}

const props = withDefaults(defineProps<FabMenuProps>(), {
    mainIcon: 'plus',
    active: false
});

const emit = defineEmits<{
    (e: 'update:active', value: boolean): void;
    (e: 'open'): void;
    (e: 'close'): void;
    (e: 'select', action: string): void;
}>();

const isOpen = computed({
    get: () => props.active,
    set: (value) => emit('update:active', value)
});

const containerRef = ref<HTMLElement | null>(null);

function toggle(): void {
    isOpen.value = !isOpen.value;
    if (isOpen.value) {
        emit('open');
    } else {
        emit('close');
    }
}

function handleItemClick(item: FabMenuItem): void {
    if (item.divider || item.section) {
        return;
    }
    if (item.action) {
        emit('select', item.action);
    }
    isOpen.value = false;
    emit('close');
}

function handleOutsideClick(event: MouseEvent): void {
    const target = event.target as Node;
    if (containerRef.value && !containerRef.value.contains(target)) {
        isOpen.value = false;
    }
}

watch(isOpen, (open) => {
    if (open) {
        window.addEventListener('click', handleOutsideClick);
    } else {
        window.removeEventListener('click', handleOutsideClick);
    }
});

onUnmounted(() => {
    window.removeEventListener('click', handleOutsideClick);
});
</script>

<template>
    <div ref="containerRef" class="fab-container" @click.stop>
        <ul class="fab-menu" :class="{ show: isOpen }" role="menu">
            <template v-for="(item, index) in items" :key="item.action || index">
                <li
                    v-if="item.section"
                    class="fab-section-title"
                    role="presentation"
                >
                    {{ item.section }}
                </li>
                <li
                    v-else-if="item.divider"
                    class="fab-divider"
                    role="separator"
                />
                <li
                    v-else
                    class="fab-item"
                    role="menuitem"
                    @click="handleItemClick(item)"
                >
                    <span v-if="item.icon" class="fab-item-icon">
                        <IconSvg :name="item.icon" size="var(--icon-sm)" monochrome />
                    </span>
                    <span class="fab-item-label">{{ item.label }}</span>
                </li>
            </template>
        </ul>

        <button
            type="button"
            class="fab-main"
            :class="{ active: isOpen }"
            :title="isOpen ? '关闭菜单' : '打开菜单'"
            aria-haspopup="true"
            :aria-expanded="isOpen"
            @click.stop="toggle"
        >
            <IconSvg :name="mainIcon" size="var(--icon-md)" />
        </button>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.fab-container {
    position: fixed;
    right: var(--fab-right);
    bottom: var(--fab-bottom);
    z-index: var(--z-fab);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3);
}

.fab-main {
    @include button-reset;
    width: var(--fab-size);
    height: var(--fab-size);
    border-radius: var(--radius-full);
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    box-shadow: var(--elevation-2);
    display: flex;
    align-items: center;
    justify-content: center;
    @include md-transition(all, var(--md-transition-medium));
    position: relative;
    // .fab-container 已自成层叠上下文，这里只在容器内压过自己的菜单
    z-index: var(--z-fab);

    &:hover {
        transform: scale(1.08);
        background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
        box-shadow: var(--elevation-3);
    }

    &.active {
        transform: rotate(45deg);
    }

    :deep(.icon-svg) {
        color: var(--md-sys-color-on-primary);
    }
}

.fab-menu {
    position: absolute;
    bottom: calc(var(--fab-size) + var(--space-3));
    right: 0;
    margin: 0;
    padding: var(--space-2);
    list-style: none;
    @include glass-surface(var(--glass-bg-strong), var(--radius-lg));
    box-shadow: var(--elevation-3);
    // 轻浮层档：菜单宽度不各写各的，与站点菜单 / 引擎下拉同一来源
    min-width: var(--pop-w-min);
    max-width: var(--pop-w-max);
    opacity: 0;
    visibility: hidden;
    transform: translateY(10px) scale(0.9);
    transform-origin: bottom right;
    @include md-transition(all, var(--md-transition-medium));
    z-index: var(--z-dropdown);

    &.show {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
    }
}

.fab-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: var(--control-h-md);
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    cursor: pointer;
    color: var(--md-sys-color-on-surface);
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    @include md-transition(all, var(--md-transition-fast));

    &:hover {
        background: var(--md-sys-color-primary-container);
        color: var(--md-sys-color-on-primary-container);
    }
}

.fab-item-icon {
    width: var(--icon-sm);
    height: var(--icon-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.fab-item-label {
    white-space: nowrap;
}

.fab-divider {
    height: 1px;
    background: var(--card-border);
    margin: var(--space-2) 0;
    list-style: none;
}

.fab-section-title {
    // 分组标题走统一的 eyebrow 混入，字号/字重/字距不再各写一遍
    @include section-label;
    padding: var(--space-1) var(--space-3);
    list-style: none;
}

@include respond-to(mobile) {
    .fab-container {
        right: var(--shell-inset) !important;
        bottom: calc(var(--header-height) + var(--shell-inset)) !important;
    }
}
</style>
