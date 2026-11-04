<script lang="ts">
import { ref } from 'vue';

// 面板可以叠面板（分类管理里直接开编辑框），栈必须跨实例共享，所以放在模块作用域。
const openStack: HTMLElement[] = [];
// 第一把锁落下前 body 的 overflow 快照；栈清空时恢复它，而不是无条件写 ''。
let bodyOverflowSnapshot: string | null = null;
// 所有实例共用一个栈，所以入栈/出栈要通知层序：层序靠栈内位置算，不靠调用方传数字
const stackVersion = ref(0);

function touchStack(): void {
    stackVersion.value += 1;
}
</script>

<script setup lang="ts">
import { computed, watch, onBeforeUnmount, nextTick } from 'vue';
import IconSvg from '@/components/icon/IconSvg.vue';

interface Props {
    /** 是否显示模态框（支持 v-model） */
    modelValue: boolean;
    /** 模态框标题 */
    title?: string;
    /** 宽度档位，对应 --panel-w-* */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** 显式最大宽度，优先级高于 size */
    maxWidth?: number | string;
    /** 最大高度，支持数字（px）或字符串 */
    maxHeight?: string;
    /** 面板位置：center 居中，top-right 从顶栏右下方展开 */
    placement?: 'center' | 'top-right';
    /** 是否显示右上角关闭按钮 */
    showClose?: boolean;
    /** 点击遮罩层是否关闭 */
    closeOnOverlay?: boolean;
    /** 按 ESC 是否关闭 */
    closeOnEsc?: boolean;
    /** 是否禁用 body 滚动（打开时） */
    lockScroll?: boolean;
    /** 内容容器额外 class */
    contentClass?: string;
    /** 内容容器额外样式 */
    contentStyle?: Record<string, string>;
    /** 主体区域额外 class */
    bodyClass?: string;
    /** 主体区域额外样式 */
    bodyStyle?: Record<string, string>;
}

const props = withDefaults(defineProps<Props>(), {
    size: 'md',
    maxHeight: '85vh',
    placement: 'center',
    showClose: true,
    closeOnOverlay: true,
    closeOnEsc: true,
    lockScroll: true,
    contentClass: '',
    contentStyle: () => ({}),
    bodyClass: '',
    bodyStyle: () => ({}),
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
    (e: 'close'): void;
    (e: 'open'): void;
    (e: 'afterEnter'): void;
}>();

const isActive = ref(false);
const contentRef = ref<HTMLElement | null>(null);
let enterTimer: ReturnType<typeof setTimeout> | null = null;
let previouslyFocused: HTMLElement | null = null;

const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

function isTopmost(): boolean {
    return openStack[openStack.length - 1] === contentRef.value;
}

function setBodyScroll(): void {
    if (!props.lockScroll) return;

    // 先清掉已脱离文档的残留面板：DOM 被外部直接移除（未走本组件卸载钩子）时，
    // 旧元素会继续顶高栈计数，让最后一个弹窗关闭/卸载后 body 滚动锁永远还不回去
    for (let i = openStack.length - 1; i >= 0; i -= 1) {
        if (!openStack[i].isConnected) openStack.splice(i, 1);
    }
    touchStack();

    if (openStack.length > 0) {
        if (bodyOverflowSnapshot === null) {
            bodyOverflowSnapshot = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
        }
    } else if (bodyOverflowSnapshot !== null) {
        document.body.style.overflow = bodyOverflowSnapshot;
        bodyOverflowSnapshot = null;
    }
}

function focusPanel(): void {
    const el = contentRef.value;
    if (!el) return;
    el.focus({ preventScroll: true });
}

function restoreFocus(): void {
    const target = previouslyFocused;
    previouslyFocused = null;
    if (target && target.isConnected) {
        target.focus({ preventScroll: true });
    }
}

function trapTab(event: KeyboardEvent): void {
    const el = contentRef.value;
    if (!el) return;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        // position:fixed 的元素 offsetParent 恒为 null，所以用矩形判断可见性
        (node) => node.getClientRects().length > 0
    );
    if (nodes.length === 0) {
        event.preventDefault();
        el.focus({ preventScroll: true });
        return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === el)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
    }
}

function handleKeydown(event: KeyboardEvent): void {
    if (!isActive.value || !isTopmost()) return;
    if (event.key === 'Escape') {
        if (!props.closeOnEsc) return;
        event.preventDefault();
        close();
    } else if (event.key === 'Tab') {
        if (contentRef.value?.contains(document.activeElement)) trapTab(event);
    }
}

function open(): void {
    if (enterTimer) clearTimeout(enterTimer);
    previouslyFocused = (document.activeElement as HTMLElement) ?? null;
    emit('open');
    enterTimer = setTimeout(() => {
        isActive.value = true;
        nextTick(focusPanel);
        emit('afterEnter');
    }, 10);
}

function close(): void {
    if (enterTimer) clearTimeout(enterTimer);
    isActive.value = false;
    emit('close');
    emit('update:modelValue', false);
}

function handleOverlayClick(event: MouseEvent): void {
    if (!props.closeOnOverlay) return;
    if (event.target === event.currentTarget) {
        close();
    }
}

watch(
    () => props.modelValue,
    (value) => {
        if (value) {
            open();
        } else {
            isActive.value = false;
        }
    },
    { immediate: true }
);

// 面板真正可见后才入栈：锁滚动、焦点归位与按键拦截都以栈顶为准
watch(isActive, (active) => {
    const el = contentRef.value;
    document.removeEventListener('keydown', handleKeydown, true);
    if (!active) {
        const index = el ? openStack.indexOf(el) : -1;
        if (index !== -1) openStack.splice(index, 1);
        restoreFocus();
    } else if (el) {
        openStack.push(el);
        document.addEventListener('keydown', handleKeydown, true);
    }
    touchStack();
    setBodyScroll();
});

onBeforeUnmount(() => {
    if (enterTimer) clearTimeout(enterTimer);
    if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', handleKeydown, true);
    }
    const index = contentRef.value ? openStack.indexOf(contentRef.value) : -1;
    if (index !== -1) openStack.splice(index, 1);
    restoreFocus();
    touchStack();
    setBodyScroll();
});

const widthStyle = computed(() => {
    if (props.maxWidth !== undefined) {
        return typeof props.maxWidth === 'number' ? `${props.maxWidth}px` : props.maxWidth;
    }
    return `var(--panel-w-${props.size})`;
});

const baseContentStyle = computed(() => ({
    maxWidth: widthStyle.value,
    maxHeight: props.maxHeight,
}));

const overlayStyle = computed(() => {
    stackVersion.value;
    const index = contentRef.value ? openStack.indexOf(contentRef.value) : -1;
    return { '--modal-depth': String(Math.max(index, 0)) };
});

const closeIconPath = 'M18 6L6 18M6 6l12 12';
</script>

<template>
    <Teleport to="body">
        <Transition name="mnt-modal" appear>
            <div
                v-show="modelValue"
                class="mnt-modal-overlay"
                :class="[
                    `mnt-modal-overlay--${placement}`,
                    { 'mnt-modal-overlay--active': isActive },
                ]"
                :style="overlayStyle"
                role="dialog"
                aria-modal="true"
                @click="handleOverlayClick"
            >
                <div
                    ref="contentRef"
                    class="mnt-modal-content"
                    :class="contentClass"
                    :style="[baseContentStyle, contentStyle]"
                    role="document"
                    tabindex="-1"
                >
                    <div v-if="$slots.header || title || showClose" class="mnt-modal-header">
                        <div class="mnt-modal-header__left">
                            <slot name="header">
                                <slot name="title">
                                    <h3 v-if="title" class="mnt-modal-title">{{ title }}</h3>
                                </slot>
                            </slot>
                        </div>
                        <button
                            v-if="showClose"
                            type="button"
                            class="mnt-modal-close"
                            aria-label="关闭"
                            @click="close"
                        >
                            <IconSvg :path="closeIconPath" size="var(--icon-sm)" color="currentColor" />
                        </button>
                    </div>

                    <div
                        v-if="$slots.default"
                        class="mnt-modal-body"
                        :class="bodyClass"
                        :style="[bodyStyle]"
                    >
                        <slot />
                    </div>

                    <div v-if="$slots.footer" class="mnt-modal-footer">
                        <slot name="footer" />
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.mnt-modal-overlay {
    @include absolute-fill;
    position: fixed;
    background: var(--scrim);
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    z-index: calc(var(--z-panel) + var(--modal-depth, 0) * var(--z-panel-step));
    opacity: 0;
    visibility: hidden;
    transition:
        opacity var(--dur-med) var(--ease-spring),
        visibility var(--dur-med) var(--ease-spring);

    &--center {
        @include flex-center(row, 0);
        padding: var(--space-4);
    }

    &--top-right {
        display: flex;
        justify-content: flex-end;
        align-items: flex-start;
        padding: calc(var(--header-height) + var(--shell-inset) * 2) var(--shell-inset) var(--shell-inset);
    }

    &--active {
        opacity: 1;
        visibility: visible;
    }
}

.mnt-modal-content {
    // 弹层里是密集表单，材质取几乎实心的那一档；圆角比外壳再大一档（--sheet-radius）。
    @include glass-surface(var(--glass-bg-opaque), var(--sheet-radius));
    box-shadow: var(--elevation-3);
    width: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    // Apple 的弹层进场是「原地放大 + 淡入」，不带位移：位移会让面板看起来
    // 像从别处飞过来，而它本来就是从脚下长出来的。
    transform: scale(0.94);
    opacity: 0;
    transition:
        transform var(--dur-med) var(--ease-decel),
        opacity var(--dur-fast) var(--ease-decel);

    .mnt-modal-overlay--top-right & {
        width: auto;
        transform-origin: top right;
    }

    .mnt-modal-overlay--active & {
        transform: scale(1);
        opacity: 1;
    }

    &:focus,
    &:focus-visible {
        outline: none;
    }
}

.mnt-modal-header {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--separator);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-shrink: 0;

    &__left {
        min-width: 0;
        flex: 1;
        display: flex;
        align-items: center;
        gap: var(--space-2);
    }
}

.mnt-modal-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    // 标题收紧字距：SF Pro 大字默认偏松
    letter-spacing: -0.02em;
    color: var(--label);
    margin: 0;
    line-height: var(--leading-tight);
}

.mnt-modal-close {
    @include icon-button(var(--control-h-sm));
    flex-shrink: 0;
    color: var(--label-secondary);

    &:hover {
        background: var(--fill);
        color: var(--color-error);
    }
}

.mnt-modal-body {
    padding: var(--space-5);
    flex: 1;
    min-height: 0;
    @include scrollable;
}

.mnt-modal-footer {
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--separator);
    display: flex;
    gap: var(--space-3);
    justify-content: flex-end;
    align-items: center;
    flex-shrink: 0;
}

// 移动端：居中面板改为底部抽屉，右上角面板改为全宽
@include respond-to(mobile) {
    .mnt-modal-overlay--center {
        padding: 0;
        align-items: flex-end;
    }

    .mnt-modal-overlay--top-right {
        padding: calc(var(--header-height) + var(--shell-inset)) 0 0;
    }

    .mnt-modal-content {
        width: 100%;
        max-height: 82vh;
        border-radius: var(--sheet-radius) var(--sheet-radius) 0 0;
        transform: translateY(100%);

        .mnt-modal-overlay--active & {
            transform: translateY(0);
        }
    }

    .mnt-modal-overlay--top-right .mnt-modal-content {
        max-height: calc(100vh - var(--header-height));
        border-radius: var(--shell-radius) var(--shell-radius) 0 0;
    }
}
</style>
