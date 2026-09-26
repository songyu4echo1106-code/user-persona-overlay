/*
 * User Persona Overlay
 * 为每个聊天独立提供一份「补充 User Persona」，仅在生成回复时
 * 通过 setExtensionPrompt 临时注入；不修改原生 Persona、角色卡与聊天历史。
 */

import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

const TEMPLATE_NAMESPACE = 'third-party/user-persona-overlay';
const METADATA_KEY = 'user_persona_overlay';
const PROMPT_KEY = 'user_persona_overlay';
const LOG_PREFIX = '[User Persona Overlay]';
const DATA_VERSION = 1;
const TEXT_DEBOUNCE_MS = 300;
const MIN_DEPTH = 0;
const MAX_DEPTH = 999;

const DEFAULT_DATA = Object.freeze({
    version: DATA_VERSION,
    enabled: false,
    nickname: '',
    content: '',
    position: extension_prompt_types.IN_PROMPT,
    depth: 2,
    role: extension_prompt_roles.SYSTEM,
});

let textFieldsSaver = null;

function normalizePosition(value) {
    const num = Number(value);
    const allowed = [
        extension_prompt_types.IN_PROMPT,
        extension_prompt_types.IN_CHAT,
        extension_prompt_types.BEFORE_PROMPT,
    ];
    return allowed.includes(num) ? num : extension_prompt_types.IN_PROMPT;
}

function normalizeDepth(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num)) {
        return DEFAULT_DATA.depth;
    }
    return Math.min(Math.max(num, MIN_DEPTH), MAX_DEPTH);
}

function normalizeRole(value) {
    const num = Number(value);
    const allowed = [
        extension_prompt_roles.SYSTEM,
        extension_prompt_roles.USER,
        extension_prompt_roles.ASSISTANT,
    ];
    return allowed.includes(num) ? num : extension_prompt_roles.SYSTEM;
}

function debounce(fn, delay) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, delay);
    };
    wrapped.flush = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
            fn();
        }
    };
    wrapped.cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    return wrapped;
}

/* ---------------- 数据层：每聊天独立读写 chatMetadata ---------------- */

function getMetadataStore() {
    try {
        const context = getContext();
        if (context && context.chatMetadata && typeof context.chatMetadata === 'object') {
            return context.chatMetadata;
        }
    } catch (error) {
        console.warn(LOG_PREFIX, 'getContext().chatMetadata 读取失败。', error);
    }
    return null;
}

function persistMetadata() {
    try {
        const context = getContext();
        const save = context?.saveMetadataDebounced ?? context?.saveMetadata;
        if (typeof save === 'function') {
            save.call(context);
        } else {
            console.warn(LOG_PREFIX, '当前版本没有 saveMetadataDebounced / saveMetadata，数据仅保留在内存。');
        }
    } catch (error) {
        console.warn(LOG_PREFIX, '保存 chatMetadata 失败。', error);
    }
}

function getOverlayData() {
    const store = getMetadataStore();
    const raw = store ? store[METADATA_KEY] : null;
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_DATA };
    }
    return {
        version: DATA_VERSION,
        enabled: Boolean(raw.enabled),
        nickname: typeof raw.nickname === 'string' ? raw.nickname : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        position: normalizePosition(raw.position),
        depth: normalizeDepth(raw.depth),
        role: normalizeRole(raw.role),
    };
}

function saveOverlayData(patch) {
    const store = getMetadataStore();
    if (!store) {
        console.warn(LOG_PREFIX, 'chatMetadata 不可用，本次修改未保存。');
        return;
    }
    store[METADATA_KEY] = { ...getOverlayData(), ...patch, version: DATA_VERSION };
    persistMetadata();
}

/* ---------------- 注入层：仅 setExtensionPrompt 内存注入，不落盘 ---------------- */

function buildInjectionText(data) {
    if (!data.enabled) {
        return '';
    }
    const content = data.content.trim();
    if (!content) {
        return '';
    }
    const name = data.nickname.trim() || 'the user';
    return `[Supplemental persona for ${name}]\n${content}`;
}

function refreshInjection() {
    const data = getOverlayData();
    const text = buildInjectionText(data);
    if (text) {
        setExtensionPrompt(PROMPT_KEY, text, data.position, data.depth, false, data.role);
    } else {
        // 空内容 + 位置 NONE：本聊天不注入，也不残留上一个聊天的内容。
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, data.depth, false, data.role);
    }
    return text;
}

/* ---------------- UI 层 ---------------- */

function updateStatusLine() {
    let text = '—';
    try {
        const context = getContext();
        const chatId = context?.getCurrentChatId?.() ?? context?.chatId ?? '';
        const charName = context?.name2 ?? '';
        text = chatId ? (charName ? `${charName} · ${chatId}` : String(chatId)) : '（尚未加载聊天）';
    } catch (error) {
        console.warn(LOG_PREFIX, '读取当前聊天信息失败。', error);
    }
    $('#upo_current_chat').text(text);
}

function updateStateBadge() {
    const data = getOverlayData();
    const badge = $('#upo_state');
    badge.attr('title', '');
    if (!data.enabled) {
        badge.text('已禁用').addClass('upo-state-off').removeClass('upo-state-on');
        return;
    }
    if (!buildInjectionText(data)) {
        badge.text('已启用 · 内容为空').addClass('upo-state-off').removeClass('upo-state-on');
        return;
    }
    const positionNames = {
        [extension_prompt_types.IN_PROMPT]: '系统提示区',
        [extension_prompt_types.IN_CHAT]: '聊天内',
        [extension_prompt_types.BEFORE_PROMPT]: '提示词最前',
    };
    const roleNames = {
        [extension_prompt_roles.SYSTEM]: 'System',
        [extension_prompt_roles.USER]: 'User',
        [extension_prompt_roles.ASSISTANT]: 'Assistant',
    };
    const depthPart = data.position === extension_prompt_types.IN_CHAT ? `（depth ${data.depth}）` : '';
    badge.text('注入中').removeClass('upo-state-off').addClass('upo-state-on');
    badge.attr('title', `位置：${positionNames[data.position]}${depthPart} · 角色：${roleNames[data.role]}`);
}

function updatePreview() {
    const data = getOverlayData();
    const text = buildInjectionText(data);
    $('#upo_preview').val(text || '（当前不会注入任何内容：未启用或内容为空）');
    updateStateBadge();
}

function toggleDepthRow() {
    const position = normalizePosition($('#upo_position').val());
    $('#upo_depth_row').toggle(position === extension_prompt_types.IN_CHAT);
}

function loadOverlayIntoPanel() {
    const data = getOverlayData();
    $('#upo_enabled').prop('checked', data.enabled);
    $('#upo_nickname').val(data.nickname);
    $('#upo_content').val(data.content);
    $('#upo_position').val(String(data.position));
    $('#upo_depth').val(data.depth);
    $('#upo_role').val(String(data.role));
    toggleDepthRow();
    updateStatusLine();
    updatePreview();
}

function bindPanel() {
    $('#upo_enabled').on('change', function () {
        saveOverlayData({ enabled: Boolean(this.checked) });
        refreshInjection();
        updatePreview();
    });

    textFieldsSaver = debounce(() => {
        saveOverlayData({
            nickname: String($('#upo_nickname').val() ?? ''),
            content: String($('#upo_content').val() ?? ''),
        });
        refreshInjection();
        updatePreview();
    }, TEXT_DEBOUNCE_MS);

    $('#upo_nickname, #upo_content').on('input', () => textFieldsSaver());

    $('#upo_position').on('change', function () {
        saveOverlayData({ position: normalizePosition(this.value) });
        toggleDepthRow();
        refreshInjection();
        updatePreview();
    });

    $('#upo_depth').on('change', function () {
        const depth = normalizeDepth(this.value);
        $(this).val(depth);
        saveOverlayData({ depth });
        refreshInjection();
        updatePreview();
    });

    $('#upo_role').on('change', function () {
        saveOverlayData({ role: normalizeRole(this.value) });
        refreshInjection();
        updatePreview();
    });
}

/* ---------------- 事件 ---------------- */

function registerEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 丢弃尚在防抖窗口内的旧文本，避免写进新聊天的元数据。
        textFieldsSaver?.cancel?.();
        loadOverlayIntoPanel();
        refreshInjection();
    });

    if (event_types.GENERATION_AFTER_COMMANDS) {
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
            // 生成前先把未落盘的文本改动保存，再刷新注入。
            textFieldsSaver?.flush?.();
            refreshInjection();
        });
    } else {
        console.warn(LOG_PREFIX, '当前版本没有 GENERATION_AFTER_COMMANDS 事件，注入刷新将只依赖编辑与 CHAT_CHANGED。');
    }
}

/* ---------------- 入口 ---------------- */

jQuery(async () => {
    try {
        const html = await renderExtensionTemplateAsync(TEMPLATE_NAMESPACE, 'settings');
        const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        if (!container.length) {
            console.error(LOG_PREFIX, '未找到扩展设置容器（#extensions_settings2 / #extensions_settings），面板未挂载。');
            return;
        }
        container.append(html);
        bindPanel();
        loadOverlayIntoPanel();
        registerEvents();
        refreshInjection();
        console.log(LOG_PREFIX, '扩展已加载。');
    } catch (error) {
        console.error(LOG_PREFIX, '扩展加载失败。', error);
    }
});
