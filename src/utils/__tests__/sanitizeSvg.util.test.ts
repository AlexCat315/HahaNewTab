/**
 * 内联 SVG 白名单清洗测试
 * 用户导入备份 / 云同步下发的 SVG 最终会进 v-html，必须挡住事件属性与外部引用。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '@/utils/sanitizeSvg.util';

describe('sanitizeSvg', () => {
    it('保留合法 SVG 元素与白名单属性', () => {
        const output = sanitizeSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
            '<path d="M0 0 L10 10" fill="red" stroke-width="2" /></svg>'
        );
        expect(output).toContain('<path');
        expect(output).toContain('d="M0 0 L10 10"');
        expect(output).toContain('fill="red"');
        expect(output).toContain('stroke-width="2"');
    });

    it('移除 script、任意 on* 属性与外部引用，保留合法图形', () => {
        const output = sanitizeSvg(
            '<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M0 0" onclick="alert(2)" style="fill:url(evil)" />' +
            '<script>alert(3)</script>' +
            '<image href="https://evil.example/x.png" />' +
            '<foreignObject><div>hi</div></foreignObject></svg>'
        );
        expect(output).toContain('<path');
        expect(output).not.toContain('onload');
        expect(output).not.toContain('onclick');
        expect(output).not.toContain('alert(');
        expect(output).not.toContain('<script');
        expect(output).not.toContain('foreignObject');
        expect(output).not.toContain('evil.example');
        expect(output).not.toContain('style=');
    });

    it('不带引号的事件属性会让 XML 解析失败，整份文档被拒绝', () => {
        expect(sanitizeSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" onload=alert(1)>' +
            '<path d="M0 0" /></svg>'
        )).toBe('');
    });

    it('非 SVG 或解析失败时返回空串', () => {
        expect(sanitizeSvg('<div>hello</div>')).toBe('');
        expect(sanitizeSvg('not an svg document')).toBe('');
        expect(sanitizeSvg('')).toBe('');
    });
});
