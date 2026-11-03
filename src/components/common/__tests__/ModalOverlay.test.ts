import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ModalOverlay from '../ModalOverlay.vue';

async function wait(ms = 50) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await nextTick();
}

describe('ModalOverlay', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.style.overflow = '';
        document.body.innerHTML = '';
    });

    it('modelValue 为 false 时隐藏内容', () => {
        mount(ModalOverlay, {
            props: { modelValue: false, title: '测试标题' },
            attachTo: document.body,
        });
        const overlay = document.querySelector('.mnt-modal-overlay') as HTMLElement;
        expect(overlay).not.toBeNull();
        expect(overlay.style.display).toBe('none');
    });

    it('modelValue 为 true 时渲染标题与默认插槽', async () => {
        mount(ModalOverlay, {
            props: { modelValue: true, title: '测试标题' },
            slots: {
                default: '<p>模态框内容</p>',
                footer: '<button>确定</button>',
            },
            attachTo: document.body,
        });

        await wait();

        const overlay = document.querySelector('.mnt-modal-overlay') as HTMLElement;
        expect(overlay.style.display).not.toBe('none');
        expect(document.querySelector('.mnt-modal-title')?.textContent).toBe('测试标题');
        expect(document.querySelector('.mnt-modal-body')?.textContent).toBe('模态框内容');
        expect(document.querySelector('.mnt-modal-footer')?.textContent).toBe('确定');
    });

    it('点击关闭按钮触发 update:modelValue 与 close 事件', async () => {
        const wrapper = mount(ModalOverlay, {
            props: { modelValue: true, title: '测试标题' },
            attachTo: document.body,
        });

        await wait();
        const closeBtn = document.querySelector('.mnt-modal-close') as HTMLButtonElement;
        expect(closeBtn).not.toBeNull();

        closeBtn.click();
        await nextTick();

        expect(wrapper.emitted('update:modelValue')).toBeTruthy();
        expect(wrapper.emitted('close')).toBeTruthy();
        expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
    });

    it('点击遮罩层默认关闭模态框', async () => {
        const wrapper = mount(ModalOverlay, {
            props: { modelValue: true },
            attachTo: document.body,
        });

        await wait();
        const overlay = document.querySelector('.mnt-modal-overlay') as HTMLElement;
        overlay?.click();
        await nextTick();

        expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
    });

    it('closeOnOverlay 为 false 时点击遮罩层不关闭', async () => {
        const wrapper = mount(ModalOverlay, {
            props: { modelValue: true, closeOnOverlay: false },
            attachTo: document.body,
        });

        await wait();
        const overlay = document.querySelector('.mnt-modal-overlay') as HTMLElement;
        overlay?.click();
        await nextTick();

        expect(wrapper.emitted('update:modelValue')).toBeFalsy();
    });

    it('支持自定义 header 插槽覆盖默认标题', async () => {
        mount(ModalOverlay, {
            props: { modelValue: true, title: '默认标题' },
            slots: {
                header: '<div class="custom-header">自定义头部</div>',
            },
            attachTo: document.body,
        });

        await wait();
        expect(document.querySelector('.custom-header')?.textContent).toBe('自定义头部');
        expect(document.querySelector('.mnt-modal-title')).toBeNull();
    });

    it('卸载后恢复 body overflow', async () => {
        const wrapper = mount(ModalOverlay, {
            props: { modelValue: true },
            attachTo: document.body,
        });

        await wait();
        wrapper.unmount();
        expect(document.body.style.overflow).toBe('');
    });

    it('层序按打开顺序递增，关闭后重新压紧', async () => {
        const first = mount(ModalOverlay, {
            props: { modelValue: false, title: '面板' },
            attachTo: document.body,
        });
        const second = mount(ModalOverlay, {
            props: { modelValue: false, title: '编辑框' },
            attachTo: document.body,
        });

        // Teleport 到 body 的遮罩按挂载顺序排列，用下标取比 wrapper.find 稳
        function depthAt(index: number) {
            const el = document.querySelectorAll('.mnt-modal-overlay')[index] as HTMLElement;
            return el.style.getPropertyValue('--modal-depth');
        }

        first.setProps({ modelValue: true });
        await wait();
        // 晚一帧入栈，模拟「面板里再开编辑框」
        second.setProps({ modelValue: true });
        await wait();

        // 后开的压在先开的之上，DOM 顺序不再决定谁盖谁
        expect(depthAt(0)).toBe('0');
        expect(depthAt(1)).toBe('1');

        second.setProps({ modelValue: false });
        await wait();
        expect(depthAt(0)).toBe('0');

        first.unmount();
        second.unmount();
    });
});
