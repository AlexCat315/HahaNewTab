import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PersonalizationPanel from '@/components/personalization/PersonalizationPanel.vue';

const themesConfig = {
    defaultTheme: 'material-rose',
    themes: [
        {
            id: 'material-rose',
            name: 'Haha娘经典',
            description: '',
            logo: '',
            isDark: false,
            colors: {
                '--md-sys-color-primary': '#B14A6B',
                '--md-sys-color-primary-container': '#FFD8E1',
                '--md-sys-color-secondary': '#7D5F65',
                '--md-sys-color-secondary-container': '#FFD8E1',
                '--md-sys-color-surface': '#FFF8F9',
                '--md-sys-color-surface-variant': '#F3DDE2',
                '--md-sys-color-on-primary': '#FFFFFF',
                '--md-sys-color-on-surface': '#201A1A',
                '--md-sys-color-on-surface-variant': '#534345'
            }
        }
    ]
};

async function wait(ms = 30): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await flushPromises();
}

const mounted: Array<{ unmount: () => void }> = [];

function track<T extends { unmount: () => void }>(wrapper: T): T {
    mounted.push(wrapper);
    return wrapper;
}

function cleanupTeleports(): void {
    document.body
        .querySelectorAll('.mnt-modal-overlay')
        .forEach((el) => el.remove());
    document.body.style.overflow = '';
}

describe('PersonalizationPanel', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
        setActivePinia(createPinia());
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(themesConfig)))
        );
    });

    afterEach(() => {
        // 不卸载会把面板留在 ModalOverlay 的模块级打开栈里，影响后续用例的滚动锁断言
        while (mounted.length) {
            mounted.pop()?.unmount();
        }
        vi.unstubAllGlobals();
        cleanupTeleports();
    });

    it('关闭时面板不可见', async () => {
        track(mount(PersonalizationPanel, {
            props: { modelValue: false, autoInit: false }
        }));

        await wait();

        const overlay = document.body.querySelector('.mnt-modal-overlay') as HTMLElement;
        expect(overlay.style.display).toBe('none');
    });

    it('打开时渲染栏目导航与各设置栏目', async () => {
        track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false }
        }));

        await wait();

        const panel = document.body.querySelector('.mnt-modal-content');
        expect(panel).not.toBeNull();
        expect(panel!.querySelectorAll('.panel-nav__item')).toHaveLength(4);
        expect(panel!.querySelector('.theme-selector')).not.toBeNull();
        expect(panel!.querySelector('.wallpaper-settings')).not.toBeNull();
        expect(panel!.querySelector('.layout-settings')).not.toBeNull();
        expect(panel!.querySelector('.cache-settings')).not.toBeNull();
        // 默认激活「主题」栏目
        expect(panel!.querySelector('.panel-nav__item.active')?.textContent).toContain('主题');
    });

    it('点击导航切换激活栏目', async () => {
        track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false }
        }));

        await wait();

        const items = document.body.querySelectorAll('.panel-nav__item');
        (items[1] as HTMLButtonElement).click();
        await wait();
        expect(document.body.querySelector('.panel-nav__item.active')?.textContent).toContain('壁纸');

        (items[2] as HTMLButtonElement).click();
        await wait();
        expect(document.body.querySelector('.panel-nav__item.active')?.textContent).toContain('页面布局');
    });

    it('重新打开时回到调用方指定的栏目，不保留上次浏览位置', async () => {
        const wrapper = track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false }
        }));

        await wait();
        const items = document.body.querySelectorAll('.panel-nav__item');
        (items[1] as HTMLButtonElement).click();
        await wait();
        expect(document.body.querySelector('.panel-nav__item.active')?.textContent).toContain('壁纸');

        await wrapper.setProps({ modelValue: false });
        await wait();
        await wrapper.setProps({ modelValue: true });
        await wait();

        expect(document.body.querySelector('.panel-nav__item.active')?.textContent).toContain('主题');
    });

    it('tab 属性可指定打开时定位的栏目', async () => {
        track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false, tab: 'layout' }
        }));

        await wait();

        expect(document.body.querySelector('.panel-nav__item.active')?.textContent).toContain('页面布局');
    });

    it('点击遮罩层触发 update:modelValue 与 close', async () => {
        const wrapper = track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false }
        }));

        await wait();

        const overlay = document.body.querySelector('.mnt-modal-overlay');
        expect(overlay).not.toBeNull();
        await overlay!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await wait();

        expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('按 ESC 关闭面板', async () => {
        const wrapper = track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false }
        }));

        await wait();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait();

        expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
    });

    it('打开时锁定页面滚动，关闭后恢复', async () => {
        const wrapper = track(mount(PersonalizationPanel, {
            props: { modelValue: true, autoInit: false }
        }));

        await wait();
        expect(document.body.style.overflow).toBe('hidden');

        await wrapper.setProps({ modelValue: false });
        await wait(60);
        expect(document.body.style.overflow).toBe('');
    });
});
