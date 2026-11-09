/**
 * 主题预加载脚本（防 FOUC）
 *
 * 在 Vue 应用挂载前同步执行：读取首帧快照里的主题选择，提前应用 CSS 变量，
 * 最后移除 data-theme-loading 属性使页面可见。
 *
 * 快照键名、结构版本、主题配置都来自 /config/boot-bundle.js（构建期由
 * scripts/gen-boot-bundle.mjs 从 storageContract.json 与 themes.json 生成），
 * 这里不再硬编码，也不再发同步 XHR。
 *
 * 扩展 CSP（script-src 'self'）禁止内联脚本，因此本文件与数据包都必须是外部文件，
 * 由 index.html / view/popup.html 按顺序引入；popup 没有 Vue 主题 store，
 * 这一份预加载就是它唯一的主题来源。
 */
(function () {
    try {
        var bundle = window.__HAHA_BOOT__;
        // 数据包缺失时不猜、不兜底硬编码：直接按默认主题显示，避免两处约定悄悄漂移
        if (!bundle || !bundle.contract || !bundle.themes) return;

        var boot = bundle.contract.boot;
        var config = bundle.themes;
        var themeKeys = boot.preload;

        // 首帧快照：内核把所有「首帧就要用到」的设置收在一个键里。
        // 结构版本对不上就整份作废，退回逐键兜底读，避免拿旧结构画出错乱的首帧。
        var snapshot = null;
        try {
            var bootRaw = localStorage.getItem(boot.key);
            if (bootRaw) {
                var bootParsed = JSON.parse(bootRaw);
                if (bootParsed && bootParsed.v === boot.version
                    && bootParsed.data && typeof bootParsed.data === 'object') {
                    snapshot = bootParsed.data;
                }
            }
        } catch (e) {
            snapshot = null;
        }

        /**
         * 升级首帧兜底：还没有快照时读旧版本的逐键镜像，保证这一帧不闪。
         * 快照一旦出现就不再走这里，所以旧键里残留的历史值不会被当成当前设置。
         */
        function bootValue(key) {
            if (snapshot) {
                return Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key] : null;
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

        var selectedThemeValue = bootValue(themeKeys.selectedThemeKey);
        var selectedTheme = typeof selectedThemeValue === 'string' ? selectedThemeValue : null;

        // 主题偏好：跟随系统时首屏就要按系统明暗取同族变体，否则会先错画一次明暗再被 Vue 纠正。
        var followSystem = false;
        var settingsFamilyId = null;
        var settingsValue = bootValue(themeKeys.themeSettingsKey);
        if (settingsValue && typeof settingsValue === 'object') {
            followSystem = settingsValue.followSystem === true;
            settingsFamilyId = typeof settingsValue.familyId === 'string'
                ? settingsValue.familyId
                : null;
        }

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
