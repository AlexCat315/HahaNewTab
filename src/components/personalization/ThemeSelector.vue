<script setup lang="ts">
/**
 * ThemeSelector - 主题选择器
 *
 * 每套主题都有明亮/深色两套配色，所以选择器拆成两层：
 * - 上方「明亮 / 深色」分段控件决定用哪一套配色渲染
 * - 下方列表只列主题族（色系），点一下即在该色系内切换
 *
 * 这样 12 个主题不会变成 24 个卡片，切换明暗也不用重新找位置。
 */
import { computed } from 'vue';
import { useTheme } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';
import IconSvg from '@/components/icon/IconSvg.vue';
import BaseButton from '@/components/common/BaseButton.vue';
import SettingsSection from '@/components/common/SettingsSection.vue';
import SettingsRow from '@/components/common/SettingsRow.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import type { ThemeFamily, ThemeMode } from '@/types/config';

export interface ThemeSelectorProps {
    /** 面板标题 */
    title?: string;
    /** 是否自动初始化主题 store */
    autoInit?: boolean;
    /** 是否显示“跟随系统”按钮 */
    showFollowSystem?: boolean;
}

const props = withDefaults(defineProps<ThemeSelectorProps>(), {
    title: '主题配色',
    autoInit: true,
    showFollowSystem: true
});

const toast = useToast();

const {
    themeFamilies,
    currentFamilyId,
    currentMode,
    selectedThemeId,
    isInitializing,
    isFollowingSystem,
    setTheme,
    setMode,
    followSystemTheme
} = useTheme({ autoInit: props.autoInit });

const familyList = computed<ThemeFamily[]>(() => themeFamilies.value);

const MODE_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
    { value: 'light', label: '明亮' },
    { value: 'dark', label: '深色' }
];

/**
 * 预览圆点：左半是明亮模式的表面色、右半是深色模式的表面色，
 * 中间的小圆是这一族的主色——一眼看出「同一色系的两种渲染」。
 */
function getPreviewStyle(family: ThemeFamily): Record<string, string> {
    const lightSurface = family.light?.colors['--md-sys-color-surface'] ?? '#FFFFFF';
    const darkSurface = family.dark?.colors['--md-sys-color-surface'] ?? '#121212';
    const accent = (currentMode.value === 'dark' ? family.dark : family.light)
        ?.colors['--md-sys-color-primary']
        ?? family.light?.colors['--md-sys-color-primary']
        ?? '#B14A6B';

    return {
        '--preview-light': lightSurface,
        '--preview-dark': darkSurface,
        '--preview-accent': accent
    };
}

/** 取这一族在当前明暗模式下的变体，缺哪一套就退回另一套 */
function variantOf(family: ThemeFamily) {
    return (currentMode.value === 'dark' ? family.dark : family.light) ?? family.light ?? family.dark;
}

async function handleSelect(family: ThemeFamily): Promise<void> {
    const target = variantOf(family);
    if (!target || target.id === selectedThemeId.value) {
        return;
    }
    try {
        await setTheme(target.id);
    } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
    }
}

async function handleModeChange(value: string | number | boolean): Promise<void> {
    const mode = value as ThemeMode;
    if (mode === currentMode.value) {
        return;
    }
    try {
        await setMode(mode);
    } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
    }
}

async function handleFollowSystem(): Promise<void> {
    try {
        await followSystemTheme();
    } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
    }
}
</script>

<template>
    <div class="theme-selector" aria-label="主题选择">
        <SettingsSection title="主题配色" description="先选明亮或深色，再挑色系；同一色系的两种渲染共用一个位置">
            <SettingsRow orientation="stacked" label="外观模式">
                <SegmentedControl
                    :model-value="currentMode"
                    :options="MODE_OPTIONS"
                    aria-label="外观模式"
                    block
                    @update:model-value="handleModeChange"
                />
            </SettingsRow>

            <div
                v-if="isInitializing && familyList.length === 0"
                class="theme-selector__loading"
                role="status"
                aria-live="polite"
            >
                正在加载主题…
            </div>

            <div v-else class="theme-options-list" role="radiogroup" :aria-label="title">
                <button
                    v-for="family in familyList"
                    :key="family.id"
                    type="button"
                    class="theme-option"
                    :class="{ active: family.id === currentFamilyId }"
                    :aria-checked="family.id === currentFamilyId"
                    role="radio"
                    :title="family.description"
                    @click="handleSelect(family)"
                >
                    <span
                        class="theme-option__preview"
                        :style="getPreviewStyle(family)"
                        aria-hidden="true"
                    >
                        <span class="theme-option__preview-dot" />
                    </span>
                    <span class="theme-option__name">{{ family.name }}</span>
                    <span v-if="!family.light || !family.dark" class="theme-option__badge">
                        {{ family.light ? '仅明亮' : '仅深色' }}
                    </span>
                    <IconSvg
                        v-if="family.id === currentFamilyId"
                        name="check"
                        :size="18"
                        class="theme-option__check"
                        aria-hidden="true"
                    />
                </button>
            </div>

            <BaseButton
                v-if="showFollowSystem"
                variant="text"
                size="small"
                block
                class="theme-selector__follow"
                @click="handleFollowSystem"
            >
                {{ isFollowingSystem ? '已跟随系统深色偏好' : '跟随系统深色偏好' }}
            </BaseButton>
        </SettingsSection>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.theme-selector {
    display: flex;
    flex-direction: column;

    &__loading {
        font-size: var(--text-sm);
        color: var(--md-sys-color-on-surface-variant);
        padding: var(--space-2) 0;
    }

    &__follow {
        margin-top: var(--space-3);
        color: var(--md-sys-color-primary);
    }
}

.theme-options-list {
    // 面板宽度变化时自动折行，不再靠一个 380px 的断点切单列
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--space-1);
    padding-top: var(--space-2);
}

.theme-option {
    @include button-reset;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    color: var(--md-sys-color-on-surface);
    text-align: left;
    width: 100%;
    border: 1px solid transparent;
    @include md-transition(all, var(--md-transition-fast));

    &:hover {
        background: var(--hover-bg);
        border-color: var(--md-sys-color-outline-variant);
    }

    &.active {
        background: var(--md-sys-color-primary-container);
        color: var(--md-sys-color-on-primary-container);
        border-color: transparent;
    }

    &__preview {
        position: relative;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        // 左半明亮表面、右半深色表面，中间是这一族的主色
        background: linear-gradient(
            135deg,
            var(--preview-light) 0 50%,
            var(--preview-dark) 50% 100%
        );
        box-shadow: inset 0 0 0 1.5px var(--preview-accent);
        @include md-transition(transform, var(--md-transition-fast));
    }

    &__preview-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--preview-accent);
    }

    &:hover &__preview,
    &.active &__preview {
        transform: scale(1.1);
    }

    &.active &__preview {
        box-shadow:
            inset 0 0 0 1.5px var(--preview-accent),
            0 0 0 2px var(--md-sys-color-primary-container);
    }

    &__name {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        flex: 1;
        min-width: 0;
        @include text-ellipsis;
    }

    &__badge {
        font-size: var(--text-xs);
        padding: 2px var(--space-2);
        border-radius: var(--radius-full);
        background: var(--md-sys-color-surface-variant);
        color: var(--md-sys-color-on-surface-variant);
        flex-shrink: 0;
        line-height: var(--leading-tight);
    }

    &__check {
        color: var(--md-sys-color-primary);
        flex-shrink: 0;
    }

    &.active &__check {
        color: var(--md-sys-color-on-primary-container);
    }
}
</style>
