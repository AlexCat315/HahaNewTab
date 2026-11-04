/**
 * useConfirm
 * 全局 Confirm / Prompt 对话框能力
 *
 * 设计：
 * - 通过模块级单例维护对话框请求队列，组件树任意位置调用 useConfirm() 均可触发。
 * - 支持 provide/inject：在根组件调用 provideConfirm() 可提供自定义 Manager；
 *   未提供时自动降级到全局单例。
 * - 提供 <MntConfirmHost /> 组件负责实际渲染，建议仅在 App.vue 中挂载一次。
 * - 禁止 emoji，图标使用 SVG 路径绘制。
 */

import {
    computed,
    defineComponent,
    getCurrentInstance,
    h,
    inject,
    onMounted,
    onUnmounted,
    provide,
    ref,
    watch,
    type CSSProperties,
    type InjectionKey,
    type Ref,
} from 'vue';

/** Confirm 选项 */
export interface ConfirmOptions {
    title?: string;
    okText?: string;
    cancelText?: string;
    isDanger?: boolean;
}

/** Prompt 选项 */
export interface PromptOptions extends ConfirmOptions {
    defaultValue?: string;
    inputPlaceholder?: string;
    inputType?: 'text' | 'password' | 'number' | 'email' | 'url' | 'search';
}

/** 对话框类型 */
export type DialogType = 'confirm' | 'prompt';

/** Confirm 请求 */
export interface ConfirmRequest {
    id: string;
    type: 'confirm';
    title: string;
    message: string;
    okText: string;
    cancelText: string;
    isDanger: boolean;
    resolve: (value: boolean) => void;
}

/** Prompt 请求 */
export interface PromptRequest {
    id: string;
    type: 'prompt';
    title: string;
    message: string;
    okText: string;
    cancelText: string;
    isDanger: boolean;
    defaultValue: string;
    placeholder: string;
    inputType: string;
    value: string;
    resolve: (value: string | null) => void;
}

/** 当前待处理的对话框请求 */
export type DialogRequest = ConfirmRequest | PromptRequest;

/** Confirm 管理器 API */
export interface ConfirmManager {
    /** 当前待处理的请求队列（只读） */
    requests: Ref<Readonly<DialogRequest[]>>;
    /** 弹出确认框，返回用户是否确认 */
    confirm(message: string, options?: ConfirmOptions): Promise<boolean>;
    /** 弹出输入框，返回用户输入或 null */
    prompt(message: string, options?: PromptOptions): Promise<string | null>;
    /** 手动 resolve 指定请求 */
    resolve(id: string, value: boolean | string | null): void;
    /** 取消指定请求 */
    cancel(id: string): void;
    /** 更新指定 prompt 请求的输入值 */
    updateValue(id: string, value: string): void;
    /** 取消并清空所有请求 */
    closeAll(): void;
}

// ==================== SVG 图标（无 emoji） ====================

const ICON_WARNING_PATHS = [
    'M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z',
    'M12 8V12',
    'M12 16H12.01',
];

const ICON_QUESTION_PATHS = [
    'M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z',
    'M9.09 9C9.32588 8.33167 9.78948 7.7681 10.4 7.40914C11.0106 7.05018 11.729 6.91899 12.4277 7.03872C13.1264 7.15845 13.7589 7.52155 14.2072 8.06379C14.6555 8.60603 14.8899 9.29155 14.8684 9.99416C14.8468 10.6968 14.5709 11.3716 14.09 11.89C13.5 12.5 12.5 13 12.5 14',
    'M12 17H12.01',
];

const ICON_EDIT_PATHS = [
    'M11 4H4C2.89543 4 2 4.89543 2 6V20C2 21.1046 2.89543 22 4 22H18C19.1046 22 20 21.1046 20 20V13',
    'M18.5 2.5C19.6645 1.33545 21.435 1.33545 22.5995 2.5C23.7641 3.66455 23.7641 5.43505 22.5995 6.59955L12 17.199L8 18.199L9 14.199L18.5 2.5Z',
];

function renderSvgIcon(paths: string[], colorClass: string): ReturnType<typeof h> {
    return h(
        'svg',
        {
            class: ['mnt-confirm-svg', colorClass],
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            width: 24,
            height: 24,
            style: { display: 'block' },
        },
        paths.map((d, i) => h('path', { key: i, d }))
    );
}

// ==================== 样式（内联，避免额外 CSS 文件） ====================
//
// 这里只用 token，不写具体值：确认框是「打断当前操作」的浮层，它必须和 ModalOverlay
// 出自同一套表面/遮罩/圆角语言，否则切主题时对话框会留着一块与卡片不同步的白底。
// 内联 style 里 var() 一样能在计算值阶段展开，所以不需要为了用 token 而拆成 SFC。

const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: '0',
    backgroundColor: 'var(--scrim)',
    backdropFilter: 'blur(var(--glass-blur))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 'var(--z-alert)',
};

const dialogStyle: CSSProperties = {
    backgroundColor: 'var(--glass-bg-strong)',
    color: 'var(--label)',
    border: '1px solid var(--glass-border)',
    borderRadius: 'var(--radius-xl)',
    padding: 'var(--space-6)',
    minWidth: '240px',
    width: 'min(90vw, var(--panel-w-sm))',
    boxShadow: 'var(--elevation-3)',
};

const iconWrapStyle: CSSProperties = {
    width: 'var(--icon-xl)',
    height: 'var(--icon-xl)',
    borderRadius: 'var(--radius-full)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 'var(--space-4)',
};

const iconInfoStyle: CSSProperties = {
    backgroundColor: 'var(--tint-primary)',
    color: 'var(--accent)',
};

const iconDangerStyle: CSSProperties = {
    backgroundColor: 'var(--tint-error)',
    color: 'var(--color-error)',
};

const titleStyle: CSSProperties = {
    margin: '0 0 var(--space-2)',
    fontSize: 'var(--text-xl)',
    fontWeight: 'var(--weight-medium)',
    lineHeight: 'var(--leading-tight)',
};

const messageStyle: CSSProperties = {
    margin: 0,
    fontSize: 'var(--text-base)',
    lineHeight: 'var(--leading-normal)',
    color: 'var(--label-secondary)',
};

const inputStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: 'var(--space-3) var(--space-4)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--card-border)',
    marginTop: 'var(--space-4)',
    background: 'var(--hover-bg)',
    color: 'inherit',
    fontSize: 'var(--text-base)',
    outline: 'none',
};

const actionsStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 'var(--space-2)',
    marginTop: 'var(--space-6)',
};

const baseBtnStyle: CSSProperties = {
    border: 'none',
    borderRadius: 'var(--radius-full)',
    padding: 'var(--space-2) var(--space-5)',
    cursor: 'pointer',
    fontSize: 'var(--text-base)',
    fontWeight: 'var(--weight-medium)',
    lineHeight: 'var(--leading-normal)',
};

// 与 BaseButton 同一套：主色实底 + on-primary 用于确认，危险操作用 error 淡底 + error 文字
// （深色主题的 error 是提亮的珊瑚色，实底压白字读不出对比）
const primaryBtnStyle: CSSProperties = {
    ...baseBtnStyle,
    backgroundColor: 'var(--accent)',
    color: 'var(--on-accent)',
};

const dangerBtnStyle: CSSProperties = {
    ...baseBtnStyle,
    backgroundColor: 'var(--tint-error)',
    color: 'var(--color-error)',
};

const secondaryBtnStyle: CSSProperties = {
    ...baseBtnStyle,
    backgroundColor: 'transparent',
    color: 'var(--accent)',
};

// ==================== Manager 工厂 ====================

let requestIdSeed = 0;

export function createConfirmManager(): ConfirmManager {
    const requests = ref<DialogRequest[]>([]) as Ref<Readonly<DialogRequest[]>>;

    function makeId(): string {
        requestIdSeed += 1;
        return `mnt_confirm_req_${requestIdSeed}_${Date.now()}`;
    }

    function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const request: ConfirmRequest = {
                id: makeId(),
                type: 'confirm',
                title: options.title ?? '提示',
                message,
                okText: options.okText ?? '确定',
                cancelText: options.cancelText ?? '取消',
                isDanger: options.isDanger ?? false,
                resolve,
            };
            (requests.value as DialogRequest[]).push(request);
        });
    }

    function prompt(message: string, options: PromptOptions = {}): Promise<string | null> {
        return new Promise<string | null>((resolve) => {
            const defaultValue = options.defaultValue ?? '';
            const request: PromptRequest = {
                id: makeId(),
                type: 'prompt',
                title: options.title ?? '请输入',
                message,
                okText: options.okText ?? '确定',
                cancelText: options.cancelText ?? '取消',
                isDanger: options.isDanger ?? false,
                defaultValue,
                placeholder: options.inputPlaceholder ?? '',
                inputType: options.inputType ?? 'text',
                value: defaultValue,
                resolve,
            };
            (requests.value as DialogRequest[]).push(request);
        });
    }

    function resolve(id: string, value: boolean | string | null): void {
        const list = requests.value as DialogRequest[];
        const index = list.findIndex((req) => req.id === id);
        if (index === -1) return;
        const [request] = list.splice(index, 1);
        if (request.type === 'confirm') {
            (request.resolve as (value: boolean) => void)(value as boolean);
        } else {
            (request.resolve as (value: string | null) => void)(value as string | null);
        }
    }

    function cancel(id: string): void {
        const request = (requests.value as DialogRequest[]).find((req) => req.id === id);
        if (!request) return;
        resolve(id, request.type === 'confirm' ? false : null);
    }

    function updateValue(id: string, value: string): void {
        const request = (requests.value as DialogRequest[]).find((req) => req.id === id);
        if (request && request.type === 'prompt') {
            request.value = value;
        }
    }

    function closeAll(): void {
        [...(requests.value as DialogRequest[])].forEach((request) => {
            resolve(request.id, request.type === 'confirm' ? false : null);
        });
    }

    return {
        requests,
        confirm,
        prompt,
        resolve,
        cancel,
        updateValue,
        closeAll,
    };
}

// ==================== Provide / Inject ====================

export const ConfirmInjectionKey: InjectionKey<ConfirmManager> = Symbol('useConfirm');

/** 全局单例 Manager */
const globalManager = createConfirmManager();

/**
 * 在组件 setup 中提供 ConfirmManager。
 * 未传入实例时默认使用全局单例，保持整个应用共用同一对话框队列。
 */
export function provideConfirm(manager?: ConfirmManager): ConfirmManager {
    const instance = manager ?? globalManager;
    provide(ConfirmInjectionKey, instance);
    return instance;
}

/**
 * 在组件 setup 中使用 ConfirmManager。
 * 若上层未 provide，则回退到全局单例。
 * 非 setup 环境（如测试顶层）直接返回全局单例，避免 inject() 警告。
 */
export function useConfirm(): ConfirmManager {
    return getCurrentInstance() ? inject(ConfirmInjectionKey, globalManager) : globalManager;
}

// ==================== 渲染宿主组件 ====================

// 记录打开前的值：确认框常常盖在面板之上，关闭时要还原成「面板还开着」的状态，
// 直接清空会让下层面板失去滚动锁定。
let savedBodyOverflow = '';

function setBodyScroll(blocked: boolean): void {
    if (typeof document === 'undefined') return;
    if (blocked) {
        savedBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    } else {
        document.body.style.overflow = savedBodyOverflow;
    }
}

export const MntConfirmHost = defineComponent({
    name: 'MntConfirmHost',
    setup() {
        const manager = inject(ConfirmInjectionKey, globalManager);
        const overlayRef = ref<HTMLDivElement | null>(null);
        const inputRef = ref<HTMLInputElement | null>(null);
        let focusTimer: ReturnType<typeof setTimeout> | null = null;
        const abortController = new AbortController();

        const current = computed(() => (manager.requests.value as DialogRequest[])[0] ?? null);

        function handleKeydown(event: KeyboardEvent): void {
            const request = current.value;
            if (!request) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                manager.cancel(request.id);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (request.type === 'confirm') {
                    manager.resolve(request.id, true);
                } else {
                    manager.resolve(request.id, request.value);
                }
            }
        }

        onMounted(() => {
            document.addEventListener('keydown', handleKeydown, { signal: abortController.signal });
        });

        onUnmounted(() => {
            abortController.abort();
            if (focusTimer) {
                clearTimeout(focusTimer);
                focusTimer = null;
            }
            setBodyScroll(false);
            manager.closeAll();
        });

        watch(
            current,
            (request) => {
                setBodyScroll(!!request);
                if (request?.type === 'prompt') {
                    if (focusTimer) clearTimeout(focusTimer);
                    focusTimer = setTimeout(() => {
                        inputRef.value?.focus();
                        inputRef.value?.select();
                    }, 50);
                }
            },
            { immediate: true }
        );

        function renderIcon(request: DialogRequest): ReturnType<typeof h> {
            const isDanger = request.isDanger;
            const paths = request.type === 'prompt' ? ICON_EDIT_PATHS : isDanger ? ICON_WARNING_PATHS : ICON_QUESTION_PATHS;
            const colorStyle = request.type === 'prompt' || !isDanger ? iconInfoStyle : iconDangerStyle;
            return h(
                'div',
                {
                    class: ['mnt-confirm-icon', isDanger ? 'mnt-confirm-icon--danger' : 'mnt-confirm-icon--info'],
                    style: { ...iconWrapStyle, ...colorStyle },
                    ariaHidden: true,
                },
                [renderSvgIcon(paths, '')]
            );
        }

        function renderButtons(request: DialogRequest): ReturnType<typeof h> {
            return h('div', { class: 'mnt-confirm-actions', style: actionsStyle }, [
                h(
                    'button',
                    {
                        class: ['mnt-confirm-btn', 'mnt-confirm-btn--secondary'],
                        type: 'button',
                        style: secondaryBtnStyle,
                        onClick: () => manager.cancel(request.id),
                    },
                    request.cancelText
                ),
                h(
                    'button',
                    {
                        class: [
                            'mnt-confirm-btn',
                            request.isDanger ? 'mnt-confirm-btn--danger' : 'mnt-confirm-btn--primary',
                        ],
                        type: 'button',
                        style: request.isDanger ? dangerBtnStyle : primaryBtnStyle,
                        onClick: () => {
                            if (request.type === 'confirm') {
                                manager.resolve(request.id, true);
                            } else {
                                manager.resolve(request.id, request.value);
                            }
                        },
                    },
                    request.okText
                ),
            ]);
        }

        function renderPromptInput(request: PromptRequest): ReturnType<typeof h> {
            return h('input', {
                ref: inputRef,
                class: 'mnt-confirm-input',
                type: request.inputType,
                value: request.value,
                placeholder: request.placeholder,
                style: inputStyle,
                onInput: (event: Event) => {
                    manager.updateValue(request.id, (event.target as HTMLInputElement).value);
                },
                onKeydown: (event: KeyboardEvent) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        manager.resolve(request.id, request.value);
                    }
                },
            });
        }

        return () => {
            const request = current.value;
            if (!request) return null;

            return h(
                'div',
                {
                    ref: overlayRef,
                    class: 'mnt-confirm-overlay',
                    role: 'presentation',
                    style: overlayStyle,
                    onClick: (event: MouseEvent) => {
                        if (event.target === overlayRef.value) {
                            manager.cancel(request.id);
                        }
                    },
                },
                [
                    h(
                        'div',
                        {
                            class: 'mnt-confirm-dialog',
                            role: 'alertdialog',
                            ariaModal: true,
                            ariaLabelledby: 'mnt-confirm-title',
                            ariaDescribedby: 'mnt-confirm-message',
                            style: dialogStyle,
                        },
                        [
                            renderIcon(request),
                            h('h3', { id: 'mnt-confirm-title', class: 'mnt-confirm-title', style: titleStyle }, request.title),
                            h('p', { id: 'mnt-confirm-message', class: 'mnt-confirm-message', style: messageStyle }, request.message),
                            request.type === 'prompt' ? renderPromptInput(request) : null,
                            renderButtons(request),
                        ]
                    ),
                ]
            );
        };
    },
});
