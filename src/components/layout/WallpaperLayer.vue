<script setup lang="ts">
/**
 * WallpaperLayer - 壁纸背景层
 *
 * 使用 useWallpaper 获取当前壁纸设置与样式，渲染背景图片层与遮罩层。
 * 该组件为纯展示层，所有交互逻辑由父组件或 useWallpaper 提供。
 */
import { computed } from 'vue';
import { useWallpaper } from '@/composables/useWallpaper';

const { wallpaperStyle, settings, hasWallpaper } = useWallpaper();

const overlayStyle = computed(() => ({
    opacity: String(settings.value.overlayOpacity)
}));

const hasBackground = computed(() => hasWallpaper.value);
</script>

<template>
    <div
        class="wallpaper-layer"
        :class="{ 'has-background': hasBackground }"
        :style="wallpaperStyle"
        aria-hidden="true"
    />
    <div
        class="wallpaper-overlay"
        :style="overlayStyle"
        aria-hidden="true"
    />
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.wallpaper-layer {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    // 结构性负层：壁纸必须压在全部内容之下，而 global.scss 解释了为什么 html 不能带
    // 背景色（body 的底色会盖在 z-index:-1 的壁纸层之上）。--z-wallpaper(0) 会被内容盖住，
    // 所以这一层不走 z 阶梯，用 token-allow 豁免。
    z-index: -1; // token-allow
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    @include md-transition(opacity filter);
    pointer-events: none;
    will-change: transform, opacity;

    &:not(.has-background) {
        background-image: none !important;
    }
}

.wallpaper-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    // 与壁纸层同层：遮罩只压壁纸，不能压内容（原因见 .wallpaper-layer 上方注释）
    z-index: -1; // token-allow
    background: var(--md-sys-color-background);
    @include md-transition(opacity);
    pointer-events: none;
}

@media (max-width: 768px) {
    .wallpaper-layer {
        filter: none !important;
    }
}
</style>
