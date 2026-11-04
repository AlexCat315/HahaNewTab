import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SelectField from '../SelectField.vue';

const OPTIONS = [
    { value: 'dev', label: '开发' },
    { value: 'media', label: '娱乐媒体' },
];

describe('SelectField', () => {
    it('渲染标签、必填星号与选项', () => {
        const wrapper = mount(SelectField, {
            props: { modelValue: 'dev', options: OPTIONS, label: '所属分类', required: true },
        });
        expect(wrapper.find('label').text()).toContain('所属分类');
        expect(wrapper.find('.mnt-select__required').exists()).toBe(true);
        expect(wrapper.findAll('option')).toHaveLength(2);
        expect(wrapper.find('select').element.value).toBe('dev');
    });

    it('placeholder 渲染成禁用的空选项', () => {
        const wrapper = mount(SelectField, {
            props: { modelValue: '', options: OPTIONS, placeholder: '请选择分类' },
        });
        const placeholder = wrapper.find('option[value=""]');
        expect(placeholder.exists()).toBe(true);
        expect(placeholder.attributes('disabled')).toBeDefined();
        expect(placeholder.text()).toBe('请选择分类');
    });

    it('切换选项应抛出字符串值', async () => {
        const wrapper = mount(SelectField, { props: { modelValue: 'dev', options: OPTIONS } });
        await wrapper.find('select').setValue('media');
        expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['media']);
    });

    it('有 error 时加错误态并显示文案，取代 hint', () => {
        const wrapper = mount(SelectField, {
            props: { modelValue: '', options: OPTIONS, hint: '说明文字', error: '请选择所属分类' },
        });
        expect(wrapper.classes()).toContain('mnt-select--error');
        expect(wrapper.find('.mnt-select__error').text()).toBe('请选择所属分类');
        expect(wrapper.find('.mnt-select__hint').exists()).toBe(false);
    });

    it('无 error 时仍显示 hint', () => {
        const wrapper = mount(SelectField, {
            props: { modelValue: 'dev', options: OPTIONS, hint: '说明文字' },
        });
        expect(wrapper.classes()).not.toContain('mnt-select--error');
        expect(wrapper.find('.mnt-select__hint').text()).toBe('说明文字');
    });

    it('传入 id 时用它作为控件 id，供外部 label 稳定引用', () => {
        const wrapper = mount(SelectField, {
            props: { modelValue: 'dev', options: OPTIONS, label: '所属分类', id: 'app-edit-category' },
        });
        expect(wrapper.find('select').attributes('id')).toBe('app-edit-category');
        expect(wrapper.find('label').attributes('for')).toBe('app-edit-category');
    });
});
