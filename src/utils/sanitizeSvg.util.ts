/**
 * 内联 SVG 白名单清洗
 *
 * 图标库里的 SVG 字符串可能来自用户导入的备份或云同步下发，最终会交给 v-html。
 * 以前只用两条正则去掉 <script> 和「带引号」的 on\w+=，不带引号的事件属性会漏过，
 * 完全依赖 CSP 兜底。这里改成 DOMParser + 元素/属性白名单：任何不在名单上的节点与属性
 * （含全部 on*、href/xlink:href、style、foreignObject）一律丢弃。
 */

const ALLOWED_TAGS = new Set([
    'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
    'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc'
]);

const ALLOWED_ATTRS = new Set([
    'xmlns', 'viewbox', 'preserveaspectratio', 'width', 'height', 'class', 'id',
    'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'transform', 'clip-rule', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'offset', 'stop-color',
    'stop-opacity', 'gradientunits', 'gradienttransform'
]);

/** 这些属性无论大小写都拒绝：事件处理器、外部引用、可执行样式 */
const FORBIDDEN_ATTR = /^(on.*|href|xlink:href|src|style|formaction)$/i;

function cleanElement(element: Element): void {
    for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (FORBIDDEN_ATTR.test(attribute.name) || !ALLOWED_ATTRS.has(name)) {
            element.removeAttribute(attribute.name);
        }
    }
    for (const child of [...element.children]) {
        if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
            child.remove();
            continue;
        }
        cleanElement(child);
    }
}

/**
 * @returns 清洗后的 SVG 字符串；不是合法 SVG 或环境不支持 DOMParser 时返回空串
 */
export function sanitizeSvg(source: string): string {
    if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
        return '';
    }
    let document: Document;
    try {
        document = new DOMParser().parseFromString(source, 'image/svg+xml');
    } catch {
        return '';
    }
    const root = document.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg' ||
        document.getElementsByTagName('parsererror').length > 0) {
        return '';
    }
    cleanElement(root);
    return new XMLSerializer().serializeToString(root);
}
