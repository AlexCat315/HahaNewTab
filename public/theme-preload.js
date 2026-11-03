/**
 * 主题预加载脚本（防 FOUC）
 *
 * 在 Vue 应用挂载前同步执行：读取首帧快照里的主题选择，
 * 通过同步 XHR 加载 config/themes.json 并提前应用 CSS 变量，
 * 最后移除 data-theme-loading 属性使页面可见。
 *
 * 主题 ID 规则：每个主题族都有 `<family>-light` / `<family>-dark` 两个变体。
 * 老版本存的是不带后缀的 ID（如 material-rose），themes.json 里的 legacyIds
 * 记录了它们原本属于哪一半，这里按表迁移，保证升级后配色不跳变。
 *
 * 快照键名与结构版本要和 src/services/storageSchema.service.ts 保持一致；
 * 这里是纯手写 ES5 的外部脚本，扩展环境 CSP（script-src 'self'）禁止内联脚本，
 * 所以必须以外部文件形式放在 public/ 下，由 index.html 以 <script src> 引入。
 */
(function () {
    try {
        // 首帧快照：内核把所有「首帧就要用到」的设置收在 __boot__ 一个键里。
        // 结构版本对不上就整份作废，退回逐键兜底读，避免拿旧结构画出错乱的首帧。
        var boot = null;
        try {
            var bootRaw = localStorage.getItem('__boot__');
            if (bootRaw) {
                var bootParsed = JSON.parse(bootRaw);
                if (bootParsed && bootParsed.v === 1
                    && bootParsed.data && typeof bootParsed.data === 'object') {
                    boot = bootParsed.data;
                }
            }
        } catch (e) {
            boot = null;
        }

        /**
         * 升级首帧兜底：还没有快照时读旧版本的逐键镜像，保证这一帧不闪。
         * 快照一旦出现就不再走这里，所以旧键里残留的历史值不会被当成当前设置。
         */
        function bootValue(key) {
            if (boot) {
                return Object.prototype.hasOwnProperty.call(boot, key) ? boot[key] : null;
            }
            var raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) {
                return null;
            }
            try {
                return JSON.parse(raw);
            } catch (e) {
                return raw;
            }
        }

        var selectedThemeValue = bootValue('selectedTheme');
        var selectedTheme = typeof selectedThemeValue === 'string' ? selectedThemeValue : null;

        // 主题偏好（与存储层 appNavigator_themeSettings 同构）：
        // 跟随系统时首屏就要按系统明暗取同族变体，否则会先错画一次明暗再被 Vue 纠正。
        var followSystem = false;
        var settingsFamilyId = null;
        var settingsValue = bootValue('appNavigator_themeSettings');
        if (settingsValue && typeof settingsValue === 'object') {
            followSystem = settingsValue.followSystem === true;
            settingsFamilyId = typeof settingsValue.familyId === 'string'
                ? settingsValue.familyId
                : null;
        }

        var request = new XMLHttpRequest();
        request.open('GET', 'config/themes.json', false);
        request.send(null);
        var config = JSON.parse(request.responseText || '{}');
        var themes = config.themes || [];
        var legacyIds = config.legacyIds || {};
        var prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        var wantedMode = prefersDark ? 'dark' : 'light';

        function byId(id) {
            for (var i = 0; i < themes.length; i += 1) {
                if (themes[i].id === id) return themes[i];
            }
            return null;
        }

        function familyOf(theme) {
            return theme ? (theme.family || theme.id) : null;
        }

        function variantOf(familyId, mode) {
            for (var i = 0; i < themes.length; i += 1) {
                if (familyOf(themes[i]) === familyId && themes[i].mode === mode) {
                    return themes[i];
                }
            }
            return null;
        }

        var theme = null;

        if (followSystem) {
            // 跟随系统：族优先取设置里的 familyId，失效时退回已保存主题的族，再退回默认族
            var followFamilyId = settingsFamilyId;
            if (!followFamilyId && selectedTheme) {
                var selectedSaved = byId(selectedTheme)
                    || (legacyIds[selectedTheme] ? byId(legacyIds[selectedTheme]) : null);
                followFamilyId = familyOf(selectedSaved) || selectedTheme;
            }
            if (followFamilyId) {
                theme = variantOf(followFamilyId, wantedMode)
                    || variantOf(followFamilyId, wantedMode === 'dark' ? 'light' : 'dark');
            }
            if (!theme) {
                var followDefault = byId(config.defaultTheme);
                theme = variantOf(familyOf(followDefault), wantedMode)
                    || followDefault
                    || themes[0];
            }
        } else if (selectedTheme) {
            theme = byId(selectedTheme);
            if (!theme && legacyIds[selectedTheme]) {
                theme = byId(legacyIds[selectedTheme]);
            }
            if (!theme) {
                // 存的是族名（极旧版本）或该变体已被移除：按系统模式取同族变体
                theme = variantOf(selectedTheme, wantedMode);
            }
        }

        if (!theme) {
            var defaultTheme = byId(config.defaultTheme);
            theme = variantOf(familyOf(defaultTheme), wantedMode)
                || defaultTheme
                || themes[0];
        }

        if (theme && theme.colors) {
            var root = document.documentElement;
            root.setAttribute('data-theme', theme.id);
            var isDark = theme.mode ? theme.mode === 'dark' : !!theme.isDark;
            if (isDark) {
                root.classList.add('dark-mode');
            }
            // 只注入基础色：卡片底、描边、hover、玻璃浮层这些派生色全部由
            // styles/variables.scss 的 color-mix 现算，首帧就已经是主题色。
            for (var key in theme.colors) {
                if (Object.prototype.hasOwnProperty.call(theme.colors, key)) {
                    root.style.setProperty(key, theme.colors[key]);
                }
            }
            var metaThemeColor = document.querySelector('meta[name="theme-color"]');
            if (metaThemeColor && theme.colors['--md-sys-color-primary']) {
                metaThemeColor.setAttribute('content', theme.colors['--md-sys-color-primary']);
            }
        }
    } catch (e) {
        // 主题预加载失败时保持默认，避免阻塞页面渲染
    } finally {
        document.documentElement.removeAttribute('data-theme-loading');
        document.documentElement.setAttribute('data-theme-loaded', 'true');
    }
})();
