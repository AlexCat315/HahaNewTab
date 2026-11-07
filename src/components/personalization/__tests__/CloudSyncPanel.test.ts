/**
 * CloudSyncPanel 测试
 * 覆盖：零配置的一键授权入口、自动跳转 GitHub 与授权码准备、取消流程、
 * 已登录态操作按钮（「立即同步」双向合并、「强制恢复云端」兜底）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CloudSyncPanel from '@/components/personalization/CloudSyncPanel.vue';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { STORAGE_KEYS } from '@/types/storage';

function createResponse(body: unknown, status = 200): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    } as Response;
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
    return wrapper.findAll('.mnt-base-button').find(button => button.text().includes(text));
}

function stubDeviceCodeResponse(): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({
        device_code: 'dc_123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900
    })));
}

describe('CloudSyncPanel', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        localStorage.clear();
        setActivePinia(createPinia());
        browserApi.resetDetection();
        // 不注入任何环境变量：Client ID 已内置，验证真实构建下的开箱即用
        vi.spyOn(window, 'open').mockImplementation(() => null);
        writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('零配置即可一键授权，面板不出现任何申请或填写入口', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const text = wrapper.text();
        expect(text).toContain('云同步');
        expect(text).toContain('未连接');
        expect(text).toContain('使用 GitHub 登录');
        expect(text).toContain('确认一次即完成登录');
        expect(text).not.toContain('OAuth App Client ID');
        expect(text).not.toContain('Token');
        expect(wrapper.find('.cloud-sync-panel__guest input').exists()).toBe(false);
        expect(findButton(wrapper, '使用 GitHub 登录')?.attributes('disabled')).toBeUndefined();
    });

    it('点击登录后自动打开授权页、复制授权码并展示用户码', async () => {
        stubDeviceCodeResponse();
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        await findButton(wrapper, '使用 GitHub 登录')!.trigger('click');
        await flushPromises();

        expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe('https://github.com/login/device/code');
        expect(window.open).toHaveBeenCalledWith(
            'https://github.com/login/device',
            '_blank',
            'noopener,noreferrer'
        );
        expect(writeText).toHaveBeenCalledWith('ABCD-1234');
        expect(wrapper.find('.cloud-sync-oauth-code').text()).toBe('ABCD-1234');
        expect(wrapper.find('.cloud-sync-oauth-link').attributes('href'))
            .toBe('https://github.com/login/device');

        await findButton(wrapper, '取消')!.trigger('click');
        await flushPromises();
        expect(wrapper.find('.cloud-sync-oauth-code').exists()).toBe(false);
        expect(wrapper.text()).toContain('使用 GitHub 登录');
        wrapper.unmount();
    });

    it('已登录时展示「立即同步」与「强制恢复云端」按钮', async () => {
        await storageManager.setMany({
            [STORAGE_KEYS.CLOUD_TOKEN]: 'gho_test',
            [STORAGE_KEYS.CLOUD_GIST_ID]: 'gist_1',
            [STORAGE_KEYS.CLOUD_USER_INFO]: { login: 'tester', id: 1, avatar: 'https://avatar.png' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({
            login: 'tester', id: 1, avatar_url: 'https://avatar.png'
        })));

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const text = wrapper.text();
        expect(text).toContain('已连接');
        expect(text).toContain('立即同步');
        expect(text).toContain('强制恢复云端');
        expect(text).toContain('清理云端数据');
        expect(text).toContain('断开连接');
    });
});
