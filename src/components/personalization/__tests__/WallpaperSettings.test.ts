import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WallpaperSettings from '@/components/personalization/WallpaperSettings.vue';
import { useWallpaperStore } from '@/stores/wallpaper.store';

describe('WallpaperSettings', () => {
    beforeEach(() => {
        localStorage.clear();
        setActivePinia(createPinia());
    });

    it('渲染标题、预设壁纸、输入框与滑块', () => {
        const wrapper = mount(WallpaperSettings, {
            props: { autoInit: false }
        });

        expect(wrapper.text()).toContain('壁纸背景');
        expect(wrapper.findAll('.wallpaper-preset')).toHaveLength(4);
        expect(wrapper.find('.wallpaper-url .mnt-base-input').exists()).toBe(true);
        expect(wrapper.findAll('.mnt-base-slider')).toHaveLength(3);
        expect(wrapper.findAll('.wallpaper-actions .mnt-base-button')).toHaveLength(2);
    });

    it('点击预设壁纸写入壁纸地址', async () => {
        const wrapper = mount(WallpaperSettings, {
            props: { autoInit: false }
        });
        const wallpaperStore = useWallpaperStore();

        await wrapper.findAll('.wallpaper-preset')[0].trigger('click');
        await flushPromises();

        expect(wallpaperStore.settings.url).toBe(
            'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80'
        );
    });

    it('没有壁纸时「移除壁纸」不可用', async () => {
        const wrapper = mount(WallpaperSettings, {
            props: { autoInit: false }
        });

        await flushPromises();

        const removeButton = wrapper
            .findAll('.wallpaper-actions .mnt-base-button')
            .find((btn) => btn.text().includes('移除壁纸'));
        expect(removeButton).toBeDefined();
        expect(removeButton!.attributes('disabled')).toBeDefined();
    });

    it('移除壁纸清空地址但保留视觉参数', async () => {
        const wrapper = mount(WallpaperSettings, {
            props: { autoInit: false }
        });
        const wallpaperStore = useWallpaperStore();

        await wrapper.findAll('.wallpaper-preset')[0].trigger('click');
        await flushPromises();
        await wallpaperStore.setBlur(6);

        const removeButton = wrapper
            .findAll('.wallpaper-actions .mnt-base-button')
            .find((btn) => btn.text().includes('移除壁纸'));
        await removeButton!.trigger('click');
        await flushPromises();

        expect(wallpaperStore.settings.url).toBe('');
        expect(wallpaperStore.settings.blur).toBe(6);
    });
});
