/**
 * 测试环境修正
 *
 * vitest 的 jsdom 环境里 window 就是 globalThis，而 Node 22+ 在全局挂了实验性
 * localStorage/sessionStorage 访问器（未传 --localstorage-file 时 getter 恒返回 undefined）。
 * 该访问器带 setter，会挡住 vitest 从 jsdom 复制过来的实现，于是所有用例读到的
 * localStorage 都是 undefined。这里用内存实现顶掉它，保证测试行为与 Node 版本无关。
 *
 * 部分用例会 vi.spyOn(Storage.prototype, 'setItem') 模拟配额写失败，因此取方法时
 * 先看原型上的实现是否已被替换成桩：是则走桩，保留和真实 Storage 一致的拦截语义。
 */

const STORAGE_API = ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const;

const prototypeStorage = Storage.prototype as Record<string, unknown>;
const pristineApi = STORAGE_API.map((name) => prototypeStorage[name]);

function isStubbed(name: (typeof STORAGE_API)[number]): boolean {
    return prototypeStorage[name] !== pristineApi[STORAGE_API.indexOf(name)];
}

function createMemoryStorage(): Storage {
    const entries = new Map<string, string>();

    const api: Record<string, (...args: never[]) => unknown> = {
        getItem(key: string) {
            const value = entries.get(String(key));
            return value === undefined ? null : value;
        },
        setItem(key: string, value: string) {
            entries.set(String(key), String(value));
        },
        removeItem(key: string) {
            entries.delete(String(key));
        },
        clear() {
            entries.clear();
        },
        key(index: number) {
            const keys = Array.from(entries.keys());
            return index >= 0 && index < keys.length ? keys[index] : null;
        }
    };

    const target = Object.create(Storage.prototype);

    return new Proxy(target, {
        get(receiverTarget, property, receiver) {
            if (typeof property === 'string') {
                if (STORAGE_API.includes(property as (typeof STORAGE_API)[number])) {
                    return isStubbed(property as (typeof STORAGE_API)[number])
                        ? prototypeStorage[property]
                        : api[property];
                }
                if (property === 'length') {
                    return entries.size;
                }
                if (!(property in receiverTarget) && entries.has(property)) {
                    return entries.get(property);
                }
            }
            return Reflect.get(receiverTarget, property, receiver);
        },
        set(receiverTarget, property, value, receiver) {
            if (typeof property === 'string' && !(property in receiverTarget)) {
                entries.set(property, String(value));
                return true;
            }
            return Reflect.set(receiverTarget, property, value, receiver);
        },
        has(receiverTarget, property) {
            return Reflect.has(receiverTarget, property) || entries.has(String(property));
        },
        ownKeys(receiverTarget) {
            return [...new Set([...Reflect.ownKeys(receiverTarget), ...entries.keys()])];
        },
        getOwnPropertyDescriptor(receiverTarget, property) {
            if (typeof property === 'string' && entries.has(property)) {
                return { value: entries.get(property), writable: true, enumerable: true, configurable: true };
            }
            return Reflect.getOwnPropertyDescriptor(receiverTarget, property);
        }
    }) as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, name, {
        value: createMemoryStorage(),
        configurable: true,
        writable: true,
        enumerable: true
    });
}

/**
 * 断网：Node 24 在全局挂了真实 fetch，图标源解析这类工具一旦在测试里被调用就会
 * 真的去访问外网，结果随网络与站点响应漂移。这里统一让它失败，被测代码走
 * 「探测不到就降级」的分支，用例才有确定性。需要探测行为的用例自行 vi.stubGlobal。
 */
globalThis.fetch = (() => Promise.reject(new TypeError('fetch is disabled in tests'))) as typeof fetch;
