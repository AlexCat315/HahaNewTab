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

/** 取这一族在当前明暗模式下的变体，缺哪一套就退回另一套 */
function variantOf(family: ThemeFamily) {
    return (currentMode.value === 'dark' ? family.dark : family.light) ?? family.light ?? family.dark;
}

/**
 * 迷你卡预览：把这一族在当前模式下的真实配色画成一张小卡（页面底 / 卡片 / 两级文字 / 主色）。
 * 之所以不用「取一两个色当色块」：用户挑主题挑的是整体观感，两个色块看不出来，
 * 而这张小卡用的就是卡片排版本身的语言，挑中哪张基本能预判界面长什么样。
 *
 * 这里的取值刻意不走当前主题的 token：预览要展示的是「那一族自己的颜色」，
 * 跟随当前主题就等于每行都长一个样。缺色时退回当前主题的同名 token（而不是硬编码色），
 * 这样预览坏掉时也只是「和界面一致」，不会出现设计体系外的颜色。
 */
function pvValue(colors: Record<string, string> | undefined, token: string): string {
    return colors?.[token] ?? `var(${token})`;
}

function getPreviewStyle(family: ThemeFamily): Record<string, string> {
    const colors = variantOf(family)?.colors;
    return {
        '--pv-surface': pvValue(colors, '--md-sys-color-surface'),
        '--pv-variant': pvValue(colors, '--md-sys-color-surface-variant'),
        '--pv-text': pvValue(colors, '--md-sys-color-on-surface'),
        '--pv-muted': pvValue(colors, '--md-sys-color-on-surface-variant'),
        '--pv-accent': pvValue(colors, '--md-sys-color-primary'),
        '--pv-container': pvValue(colors, '--md-sys-color-primary-container')
    };
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
                        <span class="theme-option__preview-bar" />
                        <span class="theme-option__preview-card">
                            <span class="theme-option__preview-line" />
                            <span class="theme-option__preview-line theme-option__preview-line--muted" />
                        </span>
                        <span class="theme-option__preview-actions">
                            <span class="theme-option__preview-action" />
                            <span class="theme-option__preview-action theme-option__preview-action--soft" />
                        </span>
                    </span>
                    <span class="theme-option__meta">
                        <span class="theme-option__name">{{ family.name }}</span>
                        <span v-if="!family.light || !family.dark" class="theme-option__badge">
                            {{ family.light ? '仅明亮' : '仅深色' }}
                        </span>
                        <IconSvg
                            v-if="family.id === currentFamilyId"
                            name="check"
                            size="var(--icon-sm)"
                            class="theme-option__check"
                            aria-hidden="true"
                        />
                    </span>
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
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    border-radius: var(--card-radius);
    color: var(--md-sys-color-on-surface);
    text-align: left;
    width: 100%;
    border: 1px solid transparent;
    @include md-transition(all, var(--md-transition-fast));

    &:hover {
        background: var(--hover-bg);
        border-color: var(--md-sys-color-outline-variant);
    }

    // 选中态用 tint 底 + 主色描边，不用 primary-container 实底：
    // 卡面已经铺了该族的颜色，整行再压一层实底会把预览读成「另一套配色」。
    &.active {
        background: var(--tint-primary);
        color: var(--md-sys-color-primary);
        border-color: var(--tint-primary-strong);
    }

    &.active &__name {
        font-weight: var(--weight-semibold);
    }

    // 迷你卡：一张按该族配色渲染的界面缩影，宽高比固定，折行时不会变形
    &__preview {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: var(--space-1);
        width: 100%;
        aspect-ratio: 16 / 10;
        padding: var(--space-2);
        overflow: hidden;
        border-radius: var(--radius-sm);
        border: 1px solid var(--pv-variant);
        background: var(--pv-surface);
        @include md-transition(box-shadow, var(--md-transition-fast));
    }

    &__preview-bar {
        width: 40%;
        height: var(--space-2);
        border-radius: var(--radius-xs);
        background: var(--pv-accent);
    }

    &__preview-card {
        display: flex;
        flex: 1;
        flex-direction: column;
        justify-content: center;
        gap: var(--space-1);
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-xs);
        background: var(--pv-variant);
    }

    &__preview-line {
        height: var(--space-1);
        width: 70%;
        border-radius: var(--radius-full);
        background: var(--pv-text);

        &--muted {
            width: 45%;
            background: var(--pv-muted);
        }
    }

    &__preview-actions {
        display: flex;
        gap: var(--space-1);
    }

    &__preview-action {
        width: var(--space-5);
        height: var(--space-2);
        border-radius: var(--radius-full);
        background: var(--pv-accent);

        &--soft {
            background: var(--pv-container);
        }
    }

    &:hover &__preview,
    &.active &__preview {
        box-shadow: var(--elevation-1);
    }

    &__meta {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        width: 100%;
    }

    &__name {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        flex: 1;
        min-width: 0;
        @include text-ellipsis;
    }

    &__badge {
        font-size: var(--text-xs);
        padding: var(--space-1) var(--space-2);
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
}
</style>
