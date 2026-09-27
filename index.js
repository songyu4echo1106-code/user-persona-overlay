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
const LIBRARY_STORAGE_KEY = 'user_persona_overlay_library';
const LOG_PREFIX = '[User Persona Overlay]';
const DATA_VERSION = 1;
const TEXT_DEBOUNCE_MS = 300;
const MIN_DEPTH = 0;
const MAX_DEPTH = 999;

const DEFAULT_DATA = Object.freeze({
    version: DATA_VERSION,
    enabled: false,
    followPersona: true, // Follow 现在是唯一注入模式；手动 position/depth/role 仅作回退
    nickname: '',
    content: '',
    position: extension_prompt_types.IN_PROMPT,
    depth: 2,
    role: extension_prompt_roles.SYSTEM,
});

// ST 原生 Persona 位置枚举（power-user.js persona_description_positions，与 extension_prompt_types 是两套枚举）
const PERSONA_POSITIONS = Object.freeze({
    IN_PROMPT: 0,
    AFTER_CHAR: 1, // 已废弃，ST 会迁移为 IN_PROMPT；不做镜像，安全回退
    TOP_AN: 2,
    BOTTOM_AN: 3,
    AT_DEPTH: 4,
    NONE: 9,
});

let textFieldsSaver = null;
let lastFollowWarnSignature = '';
let libraryEditorState = { id: null, mode: 'preview' };

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
        // 历史数据中的 false 自动升级为 true；旧的手动 position/depth/role 仍兼容读取，仅用于回退。
        followPersona: true,
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

/**
 * 防御式只读 ST 原生 Persona 当前生效配置（power_user 全局值，绝不写入）。
 * 生成时实际注入使用的就是这组全局值（选择/编辑 Persona 时会由 per-persona
 * descriptor 同步过来），因此读全局值比读 persona_descriptions 更贴近真实行为，
 * 也不依赖 userAvatar 暴露或 descriptor 是否存在。任何异常或结构不符都返回 null，
 * 由调用方回退。
 */
function getNativePersonaConfig() {
    try {
        const context = getContext();
        const powerUser = context?.powerUserSettings;
        if (!powerUser || typeof powerUser !== 'object') {
            return null;
        }
        const position = Number(powerUser.persona_description_position);
        let mappedPosition;
        if (position === PERSONA_POSITIONS.IN_PROMPT) {
            mappedPosition = extension_prompt_types.IN_PROMPT;
        } else if (position === PERSONA_POSITIONS.AT_DEPTH) {
            mappedPosition = extension_prompt_types.IN_CHAT;
        } else {
            // AFTER_CHAR(1，已废弃) / TOP_AN(2) / BOTTOM_AN(3) / NONE(9) / 未知值：
            // setExtensionPrompt 无法完整镜像（如 AN 合并、关闭注入），安全回退手动配置
            return null;
        }
        return {
            position: mappedPosition,
            depth: normalizeDepth(powerUser.persona_description_depth),
            role: normalizeRole(powerUser.persona_description_role),
        };
    } catch (error) {
        console.warn(LOG_PREFIX, '读取原生 Persona 配置失败。', error);
        return null;
    }
}

/**
 * 计算最终实际采用的注入方案。
 * follow 模式读取成功 → 镜像原生 Persona；失败 → 回退手动配置并给出原因。
 */
function resolveInjectionPlan(data) {
    if (data.followPersona) {
        const native = getNativePersonaConfig();
        if (native) {
            return {
                followed: true,
                fallbackReason: '',
                position: native.position,
                depth: native.depth,
                role: native.role,
            };
        }
        return {
            followed: false,
            fallbackReason: '跟随原生 Persona 不可用（读取失败，或当前位置为 AFTER_CHAR/TOP_AN/BOTTOM_AN/NONE 等无法镜像的类型），已回退到手动配置。',
            position: data.position,
            depth: data.depth,
            role: data.role,
        };
    }
    return {
        followed: false,
        fallbackReason: '',
        position: data.position,
        depth: data.depth,
        role: data.role,
    };
}

function warnFollowFallback(plan) {
    const signature = `${plan.position}|${plan.depth}|${plan.role}`;
    if (signature === lastFollowWarnSignature) {
        return;
    }
    lastFollowWarnSignature = signature;
    console.warn(LOG_PREFIX, plan.fallbackReason);
}

function refreshInjection() {
    const data = getOverlayData();
    const plan = resolveInjectionPlan(data);
    if (plan.followed) {
        lastFollowWarnSignature = '';
    } else if (plan.fallbackReason) {
        warnFollowFallback(plan);
    }
    const text = buildInjectionText(data);
    if (text) {
        setExtensionPrompt(PROMPT_KEY, text, plan.position, plan.depth, false, plan.role);
    } else {
        // 空内容 + 位置 NONE：本聊天不注入，也不残留上一个聊天的内容。
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, plan.depth, false, plan.role);
    }
    return { text, plan };
}

/* ------------ Persona 存档层：localStorage，独立于聊天数据，不直接参与生成 ------------ */

function notify(message, type = 'info') {
    const toast = globalThis.toastr?.[type];
    if (typeof toast === 'function') {
        toast(message);
    } else {
        console.log(LOG_PREFIX, message);
    }
}

function createLibraryId() {
    return globalThis.crypto?.randomUUID?.()
        ?? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadLibrary() {
    try {
        const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const list = JSON.parse(raw);
        if (!Array.isArray(list)) {
            return [];
        }
        return list
            .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.content === 'string')
            .map(item => ({
                id: item.id,
                name: typeof item.name === 'string' ? item.name : '',
                nickname: typeof item.nickname === 'string' ? item.nickname : '',
                content: item.content,
                createdAt: Number(item.createdAt) || Date.now(),
                updatedAt: Number(item.updatedAt) || Date.now(),
            }));
    } catch (error) {
        console.warn(LOG_PREFIX, '读取 Persona 存档失败。', error);
        return [];
    }
}

function saveLibrary(list) {
    try {
        localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(list));
        return true;
    } catch (error) {
        console.warn(LOG_PREFIX, '写入 Persona 存档失败。', error);
        notify('Persona 存档写入失败（localStorage 不可用或已满）。', 'error');
        return false;
    }
}

function saveCurrentToLibrary() {
    const data = getOverlayData();
    if (!data.content.trim()) {
        notify('当前补充 Persona 内容为空，未创建存档。', 'warning');
        return;
    }
    const name = String($('#upo_lib_name').val() ?? '').trim();
    if (!name) {
        notify('请先填写存档名称。', 'warning');
        return;
    }
    const list = loadLibrary();
    const now = Date.now();
    list.push({
        id: createLibraryId(),
        name,
        nickname: data.nickname.trim(),
        content: data.content,
        createdAt: now,
        updatedAt: now,
    });
    if (!saveLibrary(list)) {
        return;
    }
    $('#upo_lib_name').val('');
    renderLibrary();
    notify(`已保存 Persona 存档「${name}」。`, 'success');
}

function applyLibraryPersona(id) {
    const item = loadLibrary().find(entry => entry.id === id);
    if (!item) {
        notify('未找到该存档，可能已被删除。', 'warning');
        renderLibrary();
        return;
    }
    // 丢弃尚在防抖窗口内的输入，避免随后用旧字段值覆盖刚应用的内容。
    textFieldsSaver?.cancel?.();
    saveOverlayData({ nickname: item.nickname, content: item.content });
    $('#upo_nickname').val(item.nickname);
    $('#upo_content').val(item.content);
    refreshInjection();
    updatePreview();
    notify(`已应用 Persona 存档「${item.name}」到当前聊天。`, 'success');
}

function deleteLibraryPersona(id) {
    const item = loadLibrary().find(entry => entry.id === id);
    if (!item) {
        renderLibrary();
        return;
    }
    if (!confirm(`删除 Persona 存档「${item.name}」？只会删除存档，不影响任何聊天。`)) {
        return;
    }
    saveLibrary(loadLibrary().filter(entry => entry.id !== id));
    if (libraryEditorState.id === id) {
        closeLibraryEditor();
    }
    renderLibrary();
}

/**
 * 打开存档的只读预览 / 编辑区域。仅操作 localStorage 中的存档，
 * 不读取也不修改当前聊天的 chatMetadata。
 */
function openLibraryEditor(id, mode) {
    const item = loadLibrary().find(entry => entry.id === id);
    if (!item) {
        notify('未找到该存档，可能已被删除。', 'warning');
        renderLibrary();
        return;
    }
    const isEdit = mode === 'edit';
    libraryEditorState = { id, mode: isEdit ? 'edit' : 'preview' };
    $('#upo_lib_edit_name').val(item.name);
    $('#upo_lib_edit_nickname').val(item.nickname);
    $('#upo_lib_edit_content').val(item.content);
    $('#upo_lib_edit_name, #upo_lib_edit_nickname, #upo_lib_edit_content').prop('readonly', !isEdit);
    $('#upo_lib_edit_save').toggle(isEdit);
    $('#upo_lib_editor_hint').text(isEdit
        ? '编辑仅修改此存档；已应用过该存档的聊天不会自动更新，需要时请在目标聊天重新点击「应用」。'
        : '只读预览：不会修改当前聊天，也不会修改存档。');
    $('#upo_lib_editor').show();
}

function closeLibraryEditor() {
    libraryEditorState = { id: null, mode: 'preview' };
    $('#upo_lib_editor').hide();
}

function saveLibraryEditor() {
    const { id, mode } = libraryEditorState;
    if (mode !== 'edit' || !id) {
        return;
    }
    const list = loadLibrary();
    const item = list.find(entry => entry.id === id);
    if (!item) {
        notify('未找到该存档，可能已被删除。', 'warning');
        closeLibraryEditor();
        renderLibrary();
        return;
    }
    const name = String($('#upo_lib_edit_name').val() ?? '').trim();
    if (!name) {
        notify('存档名称不能为空。', 'warning');
        return;
    }
    item.name = name;
    item.nickname = String($('#upo_lib_edit_nickname').val() ?? '').trim();
    item.content = String($('#upo_lib_edit_content').val() ?? '');
    item.updatedAt = Date.now();
    if (!saveLibrary(list)) {
        return;
    }
    closeLibraryEditor();
    renderLibrary();
    notify(`已保存 Persona 存档「${name}」的修改。`, 'success');
}

function renderLibrary() {
    const list = loadLibrary();
    const container = $('#upo_lib_list');
    container.empty();
    if (!list.length) {
        container.append($('<div class="upo-library-empty upo-hint"></div>').text('（暂无存档）'));
        return;
    }
    for (const item of list) {
        const name = $('<div class="upo-library-item-name"></div>').text(item.name || '（未命名）');
        if (item.nickname) {
            name.append($('<small></small>').text(` · 昵称：${item.nickname}`));
        }
        const previewButton = $('<input type="button" class="menu_button" value="预览" />')
            .on('click', () => openLibraryEditor(item.id, 'preview'));
        const applyButton = $('<input type="button" class="menu_button" value="应用" />')
            .on('click', () => applyLibraryPersona(item.id));
        const editButton = $('<input type="button" class="menu_button" value="编辑" />')
            .on('click', () => openLibraryEditor(item.id, 'edit'));
        const deleteButton = $('<input type="button" class="menu_button" value="删除" />')
            .on('click', () => deleteLibraryPersona(item.id));
        const actions = $('<div class="upo-library-item-actions"></div>').append(previewButton, applyButton, editButton, deleteButton);
        container.append($('<div class="upo-library-item"></div>').append(name, actions));
    }
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
    const plan = resolveInjectionPlan(data);
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
    const depthPart = plan.position === extension_prompt_types.IN_CHAT ? `（depth ${plan.depth}）` : '';
    badge.text('注入中').removeClass('upo-state-off').addClass('upo-state-on');
    badge.attr('title', `位置：${positionNames[plan.position]}${depthPart} · 角色：${roleNames[plan.role]}`);
}

function updatePlanInfo(plan) {
    const positionNames = {
        [extension_prompt_types.IN_PROMPT]: 'IN_PROMPT（系统提示区）',
        [extension_prompt_types.IN_CHAT]: 'IN_CHAT（聊天内）',
        [extension_prompt_types.BEFORE_PROMPT]: 'BEFORE_PROMPT（提示词最前）',
    };
    const roleNames = {
        [extension_prompt_roles.SYSTEM]: 'System',
        [extension_prompt_roles.USER]: 'User',
        [extension_prompt_roles.ASSISTANT]: 'Assistant',
    };
    const details = `实际位置：${positionNames[plan.position]} · 角色：${roleNames[plan.role]} · Depth：${plan.depth}`;
    const text = plan.followed
        ? `已跟随原生 Persona 位置（镜像） — ${details}`
        : `跟随不可用，已回退到手动配置 — ${details}`;
    $('#upo_plan_info').text(text);
}

function updatePreview() {
    const data = getOverlayData();
    const plan = resolveInjectionPlan(data);
    const text = buildInjectionText(data);
    $('#upo_preview').val(text || '（当前不会注入任何内容：未启用或内容为空）');
    updatePlanInfo(plan);
    updateStateBadge();
}

function loadOverlayIntoPanel() {
    const data = getOverlayData();
    $('#upo_enabled').prop('checked', data.enabled);
    $('#upo_nickname').val(data.nickname);
    $('#upo_content').val(data.content);
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

    $('#upo_lib_save').on('click', saveCurrentToLibrary);

    $('#upo_follow_refresh').on('click', () => {
        // 手动强制同步：重新读取原生 Persona 生效配置并重算注入计划；不修改原生 Persona。
        lastFollowWarnSignature = '';
        refreshInjection();
        updatePreview();
        notify('已重新读取原生 Persona 配置并刷新 Follow 状态。', 'info');
    });

    $('#upo_lib_edit_save').on('click', saveLibraryEditor);
    $('#upo_lib_edit_cancel').on('click', closeLibraryEditor);
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

    if (event_types.PERSONA_CHANGED) {
        eventSource.on(event_types.PERSONA_CHANGED, () => {
            // overlay 数据存于 chatMetadata，与 Persona 无关；仅按新 Persona 重算注入方案并刷新 UI，不写回原生 Persona 数据。
            refreshInjection();
            updatePreview();
        });
    } else {
        console.warn(LOG_PREFIX, '当前版本没有 PERSONA_CHANGED 事件，Persona 切换后需通过编辑或切换聊天触发刷新。');
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
        renderLibrary();
        loadOverlayIntoPanel();
        registerEvents();
        refreshInjection();
        console.log(LOG_PREFIX, '扩展已加载。');
    } catch (error) {
        console.error(LOG_PREFIX, '扩展加载失败。', error);
    }
});
