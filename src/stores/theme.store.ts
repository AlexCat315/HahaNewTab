/**
 * 主题状态管理（Pinia Store）
 *
 * 职责：
 * - 管理当前主题 ID、深色模式状态、主题列表
 * - 加载并缓存 public/config/themes.json
 * - 将主题基础 CSS 变量注入 document.documentElement
 *   （所有派生色由 styles/variables.scss 的 color-mix 给出，这里不重算第二份）
 * - 监听系统深色偏好变化
 * - 持久化交给 usePersistentSlice（selectedTheme 存具体变体，
 *   appNavigator_themeSettings 存跟随系统开关与主题族）
 *
 * 与原项目 js/ThemeManager.js 行为保持一致：
 * - 默认主题为 themes.json 中的 defaultTheme
 * - 未保存主题且系统偏好深色时，自动选择首个深色主题
 * - 应用主题时注入基础 colors
 * - 深色主题为 body 添加 dark-mode 类
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { usePersistentSlice } from '@/composables/usePersistentSlice';
import { loadThemes } from '@/services/config.service';
import { STORAGE_KEYS } from '@/types/storage';
import type { StorageValue, ThemeSettings } from '@/types/storage';
import type { Theme, ThemeFamily, ThemeMode } from '@/types/config';

/**
 * 解析持久化的主题偏好设置。
 * 结构不合法（旧版残留 / 手改 / 缺字段）时返回 null，调用方按默认值处理。
 */
function parseThemeSettings(raw: StorageValue | null): ThemeSettings | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const candidate = raw as Record<string, unknown>;
    if (
        typeof candidate.followSystem !== 'boolean' ||
        typeof candidate.familyId !== 'string'
    ) {
        return null;
    }
    return {
        followSystem: candidate.followSystem,
        familyId: candidate.familyId
    };
}

/** 获取系统深色偏好媒体查询对象 */
function getDarkModeMediaQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || !window.matchMedia) {
        return null;
    }
    return window.matchMedia('(prefers-color-scheme: dark)');
}

export const useThemeStore = defineStore('theme', () => {
    // State
    const themes = ref<Theme[]>([]);
    const defaultThemeId = ref<string>('material-rose-light');
    const selectedThemeId = ref<string | null>(null);
    const systemPrefersDark = ref<boolean>(false);
    const followSystem = ref<boolean>(false);
    /**
     * 主题族偏好：跟随系统时决定用哪套色系，只有明暗由系统定。
     * 与 followSystem 一起存在 appNavigator_themeSettings 里。
     */
    const preferredFamilyId = ref<string>('');
    const isReady = ref<boolean>(false);
    const error = ref<string | null>(null);
    /** 旧主题 ID → 新变体 ID 的迁移表（来自 themes.json） */
    const legacyIds = ref<Record<string, string>>({});

    const slice = usePersistentSlice({
        label: 'ThemeStore',
        keys: [
            {
                key: STORAGE_KEYS.SELECTED_THEME,
                apply: raw => {
                    selectedThemeId.value = typeof raw === 'string' && raw ? raw : null;
                },
                read: () => selectedThemeId.value
            },
            {
                key: STORAGE_KEYS.THEME_SETTINGS,
                apply: raw => {
                    const settings = parseThemeSettings(raw);
                    followSystem.value = settings?.followSystem ?? false;
                    preferredFamilyId.value = settings?.familyId ?? '';
                },
                read: () => ({
                    followSystem: followSystem.value,
                    familyId: preferredFamilyId.value
                } satisfies ThemeSettings)
            }
        ]
    });

    // 主题直接决定首屏配色，等异步存储回来再上色会闪一下：先从首帧快照同步取值
    slice.applyBoot();

    // Helpers（先于 getter 定义，供 computed 使用）
    /**
     * 取主题的模式：优先读 mode 字段，旧配置按 isDark 推断
     */
    function resolveMode(theme: Theme | undefined): ThemeMode {
        if (!theme) {
            return systemPrefersDark.value ? 'dark' : 'light';
        }
        if (theme.mode === 'light' || theme.mode === 'dark') {
            return theme.mode;
        }
        return theme.isDark ? 'dark' : 'light';
    }

    /**
     * 取主题所属的族：旧配置没有 family 字段时以 id 兜底
     */
    function resolveFamilyId(theme: Theme | undefined): string {
        if (!theme) {
            return defaultThemeId.value;
        }
        return theme.family || theme.id;
    }

    // Getters
    const currentTheme = computed<Theme | undefined>(() => {
        const id = selectedThemeId.value || defaultThemeId.value;
        return themes.value.find(theme => theme.id === id);
    });

    const isDark = computed<boolean>(() => {
        if (currentTheme.value) {
            return resolveMode(currentTheme.value) === 'dark';
        }
        return systemPrefersDark.value;
    });

    const themeOptions = computed<Theme[]>(() => themes.value);

    const availableThemeIds = computed<string[]>(() => themes.value.map(t => t.id));

    /** 当前主题模式 */
    const currentMode = computed<ThemeMode>(() => resolveMode(currentTheme.value));

    /** 当前主题所属的族 ID */
    const currentFamilyId = computed<string>(() => resolveFamilyId(currentTheme.value));

    /**
     * 主题族列表：同色系的明/暗变体合并为一项，供选择器按族展示
     */
    const themeFamilies = computed<ThemeFamily[]>(() => {
        const families = new Map<string, ThemeFamily>();
        for (const theme of themes.value) {
            const id = resolveFamilyId(theme);
            let family = families.get(id);
            if (!family) {
                family = {
                    id,
                    name: theme.name,
                    description: theme.description,
                    logo: theme.logo,
                };
                families.set(id, family);
            }
            family[resolveMode(theme)] = theme;
        }
        return Array.from(families.values());
    });

    /**
     * 取指定族在指定模式下的变体 ID；该模式缺失时回退到另一模式
     */
    function findVariantId(familyId: string, mode: ThemeMode): string | null {
        const family = themeFamilies.value.find(item => item.id === familyId);
        if (!family) {
            return null;
        }
        const preferred = mode === 'dark' ? family.dark : family.light;
        const fallback = mode === 'dark' ? family.light : family.dark;
        return (preferred ?? fallback)?.id ?? null;
    }

    /**
     * 把任意（可能是旧版本的）主题 ID 归一成当前配置里存在的变体 ID。
     * 迁移顺序：直接命中 → legacyIds 映射 → 当作族名取当前系统模式下的变体。
     */
    function normalizeThemeId(themeId: string | null | undefined): string | null {
        if (!themeId) {
            return null;
        }
        if (themes.value.some(theme => theme.id === themeId)) {
            return themeId;
        }
        const migrated = legacyIds.value[themeId];
        if (migrated && themes.value.some(theme => theme.id === migrated)) {
            return migrated;
        }
        return findVariantId(themeId, systemPrefersDark.value ? 'dark' : 'light');
    }

    /**
     * 获取默认主题 ID
     * 以配置里的 defaultTheme 所属的族为基准，按系统深色偏好挑对应模式
     */
    function resolveDefaultThemeId(): string {
        const mode: ThemeMode = systemPrefersDark.value ? 'dark' : 'light';
        const defaultTheme = themes.value.find(theme => theme.id === defaultThemeId.value);
        const familyId = resolveFamilyId(defaultTheme);
        return findVariantId(familyId, mode) ?? defaultThemeId.value;
    }

    /**
     * 注入主题基础颜色变量
     */
    function injectBaseVariables(theme: Theme): void {
        if (typeof document === 'undefined') {
            return;
        }
        const root = document.documentElement;
        Object.entries(theme.colors).forEach(([key, value]) => {
            root.style.setProperty(key, value);
        });
    }

    /**
     * 清除所有注入的 CSS 变量
     */
    function clearInjectedVariables(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const root = document.documentElement;
        Object.keys(currentTheme.value?.colors ?? {}).forEach(key => {
            root.style.removeProperty(key);
        });
    }

    /**
     * 更新 dark-mode 类
     *
     * 必须同时挂在 html 与 body 上：
     * - theme-preload.js 只能给 html 加（那时 body 还不一定存在）
     * - 组件里的深色覆盖写的是 `html.dark-mode .child`，依赖 html 上的类
     * 只挂 body 会导致预加载失败时深色覆盖整片失效。
     *
     * 注意别用 `:global(html.dark-mode) { … }` 包裹后代：Vue 的 scoped 编译会把
     * 后代选择器整个丢掉，声明直接落到 html 上（曾经因此让 html 带上了背景色，
     * 盖住 z-index:-1 的壁纸层，深色模式下壁纸整片消失）。
     */
    function updateBodyClass(dark: boolean): void {
        if (typeof document === 'undefined') {
            return;
        }
        const targets = [document.documentElement, document.body];
        for (const element of targets) {
            if (!element) continue;
            if (dark) {
                element.classList.add('dark-mode');
            } else {
                element.classList.remove('dark-mode');
            }
        }
    }

    /**
     * 应用指定主题到 DOM 与状态（不持久化）
     */
    function applyThemeToDom(themeId: string): Theme | null {
        const theme = themes.value.find(t => t.id === themeId);
        if (!theme) {
            console.error(`ThemeStore: 找不到主题 ${themeId}`);
            return null;
        }

        injectBaseVariables(theme);
        updateBodyClass(resolveMode(theme) === 'dark');
        if (typeof document !== 'undefined') {
            document.documentElement.setAttribute('data-theme', theme.id);
        }
        selectedThemeId.value = theme.id;

        return theme;
    }

    /**
     * 加载主题配置与已保存主题
     * 应用默认或已保存主题，并启动系统深色偏好监听
     */
    async function initialize(): Promise<void> {
        error.value = null;

        try {
            const config = await loadThemes();
            if (config) {
                themes.value = config.themes;
                legacyIds.value = config.legacyIds ?? {};
                defaultThemeId.value = config.defaultTheme || config.themes[0]?.id || 'material-rose-light';
            }

            const mediaQuery = getDarkModeMediaQuery();
            if (mediaQuery) {
                systemPrefersDark.value = mediaQuery.matches;
                mediaQuery.addEventListener('change', handleSystemDarkChange);
            }

            await slice.load();

            // load 之后内存里还是存储原值（未迁移的旧 ID、原来的跟随开关与主题族），
            // 归一化后要拿它判断是否需要写回
            const savedTheme = selectedThemeId.value;
            const savedFollowSystem = followSystem.value;
            const savedFamilyId = preferredFamilyId.value;

            const normalizedId = savedTheme ? normalizeThemeId(savedTheme) : null;
            const hasSavedTheme = savedTheme !== null;

            let initialThemeId: string;
            let shouldFollowSystem = false;

            if (savedFollowSystem) {
                // 跟随系统：族优先取设置里的 familyId，失效时退回已保存主题的族，再退回默认族
                shouldFollowSystem = true;
                const settingsFamilyValid = themeFamilies.value
                    .some(family => family.id === savedFamilyId);
                const fallbackTheme = normalizedId
                    ? themes.value.find(theme => theme.id === normalizedId)
                    : undefined;
                const familyId = settingsFamilyValid
                    ? savedFamilyId
                    : resolveFamilyId(fallbackTheme);
                initialThemeId = findVariantId(
                    familyId,
                    systemPrefersDark.value ? 'dark' : 'light'
                ) ?? resolveDefaultThemeId();
            } else {
                initialThemeId = normalizedId ?? resolveDefaultThemeId();
            }

            applyThemeToDom(initialThemeId);
            followSystem.value = shouldFollowSystem;
            preferredFamilyId.value = currentFamilyId.value;

            // 首次使用默认主题、旧版主题 ID 被迁移、或主题偏好缺失/不一致时写回，
            // 保证首屏与存储一致（包含跟随系统开关，重启后才能恢复）
            const needsWrite = !hasSavedTheme
                || normalizedId !== savedTheme
                || savedFollowSystem !== shouldFollowSystem
                || savedFamilyId !== preferredFamilyId.value;
            if (needsWrite) {
                selectedThemeId.value = initialThemeId;
                try {
                    await slice.persist();
                } catch (err) {
                    console.warn('ThemeStore: 持久化主题设置失败', err);
                }
            }

            isReady.value = true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            error.value = message;
            console.error('ThemeStore: 初始化失败', message);
            throw err;
        }
    }

    /**
     * 把 DOM 退回指定主题
     * 持久化失败时用：内存状态由 slice 回滚，主题注入的 CSS 变量与 dark-mode 类要自己复原。
     */
    function restoreThemeDom(themeId: string | null): void {
        if (themeId) {
            applyThemeToDom(themeId);
        } else {
            clearInjectedVariables();
            selectedThemeId.value = themeId;
        }
    }

    /**
     * 主动设置并持久化当前主题
     * 写操作返回前已完成持久化；失败时回滚本地状态与 DOM
     */
    async function setTheme(themeId: string): Promise<void> {
        const previousThemeId = selectedThemeId.value;

        const theme = applyThemeToDom(themeId);
        if (!theme) {
            throw new Error(`ThemeStore: 无法应用未知主题 ${themeId}`);
        }

        try {
            // 具体变体与主题偏好一起持久化：手动选择意味着关闭跟随系统
            await slice.mutate(() => {
                selectedThemeId.value = themeId;
                followSystem.value = false;
                preferredFamilyId.value = resolveFamilyId(theme);
            });
        } catch (err) {
            restoreThemeDom(previousThemeId);
            throw err;
        }
    }

    /**
     * 跟随系统深色偏好
     * 持久化跟随系统开关与当前主题族，浏览器重启后仍保持跟随。
     * 保留当前主题族，只让系统决定用明亮还是深色渲染。
     */
    async function followSystemTheme(): Promise<void> {
        const previousThemeId = selectedThemeId.value;
        const familyId = currentFamilyId.value;
        const targetId = findVariantId(familyId, systemPrefersDark.value ? 'dark' : 'light')
            ?? resolveDefaultThemeId();

        applyThemeToDom(targetId);

        try {
            // 跟随开关与主题族一起落盘；具体变体也同步为当前系统模式下的渲染结果
            await slice.mutate(() => {
                selectedThemeId.value = targetId;
                followSystem.value = true;
                preferredFamilyId.value = familyId;
            });
        } catch (err) {
            restoreThemeDom(previousThemeId);
            throw err;
        }
    }

    /**
     * 切换当前主题的明/暗模式（保持主题族不变）
     * 对应「同一个主题的两套配色」——换模式不换色系。
     */
    async function setMode(mode: ThemeMode): Promise<void> {
        if (mode !== 'light' && mode !== 'dark') {
            return;
        }
        const targetId = findVariantId(currentFamilyId.value, mode);
        if (!targetId) {
            // 该族缺少对应变体：至少保证 dark-mode 类与选择器状态一致
            updateBodyClass(mode === 'dark');
            return;
        }
        if (targetId === selectedThemeId.value) {
            return;
        }
        await setTheme(targetId);
    }

    /**
     * 系统深色偏好变化处理器
     *
     * 跟随系统时保持当前主题族不变、只切明暗，而不是跳到"第一个深色主题"——
     * 用户选的是色系，系统偏好只该决定这套色系用明亮还是深色渲染。
     */
    function handleSystemDarkChange(event: MediaQueryListEvent): void {
        systemPrefersDark.value = event.matches;
        if (followSystem.value) {
            const targetId = findVariantId(currentFamilyId.value, event.matches ? 'dark' : 'light');
            if (targetId) {
                applyThemeToDom(targetId);
            }
            return;
        }
        if (!selectedThemeId.value) {
            applyThemeToDom(resolveDefaultThemeId());
        }
    }

    /**
     * 手动刷新主题配置（重新加载 themes.json）
     */
    async function refreshThemes(): Promise<void> {
        const config = await loadThemes();
        if (config) {
            themes.value = config.themes;
            legacyIds.value = config.legacyIds ?? {};
            defaultThemeId.value = config.defaultTheme || config.themes[0]?.id || 'material-rose-light';
        }
        const currentId = normalizeThemeId(selectedThemeId.value)
            ?? resolveDefaultThemeId();
        applyThemeToDom(currentId);
    }

    /**
     * 切换为下一个主题族（循环）
     * 只在族之间轮换，保持当前明暗模式，避免每按一次都翻一次明暗。
     */
    async function cycleTheme(): Promise<void> {
        const families = themeFamilies.value;
        if (families.length === 0) {
            return;
        }
        const currentIndex = families.findIndex(family => family.id === currentFamilyId.value);
        const nextIndex = currentIndex === -1
            ? 0
            : (currentIndex + 1) % families.length;
        const targetId = findVariantId(families[nextIndex].id, currentMode.value);
        if (targetId) {
            await setTheme(targetId);
        }
    }

    return {
        // State
        themes,
        defaultThemeId,
        selectedThemeId,
        systemPrefersDark,
        followSystem,
        isReady,
        error,
        legacyIds,
        // Getters
        currentTheme,
        isDark,
        currentMode,
        currentFamilyId,
        themeFamilies,
        themeOptions,
        availableThemeIds,
        // Actions
        initialize,
        setTheme,
        setMode,
        followSystemTheme,
        refreshThemes,
        cycleTheme,
        resolveDefaultThemeId,
        normalizeThemeId,
        findVariantId,
    };
});
