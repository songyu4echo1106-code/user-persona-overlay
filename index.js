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
const EXTENSION_SETTINGS_KEY = 'user_persona_overlay';
const FLOATING_ICON_URL = 'scripts/extensions/third-party/user-persona-overlay/assets/kirimi.png';
const FLOATING_DRAG_THRESHOLD_PX = 8;
const FLOATING_SIZES = Object.freeze({
    small: 44,
    medium: 56,
    large: 72,
});
const DEFAULT_FLOATING_SETTINGS = Object.freeze({
    floatingEnabled: false,
    floatingIcon: 'kirimi',
    floatingSize: 'medium',
    floatingTheme: 'light',
    floatingPosition: null, // { x, y } 为占视口宽高的比例，渲染时再换算并夹取，避免视口变化后跑出屏幕
});
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
let floatingFieldsSaver = null;

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

/* ------ 扩展级设置层：extensionSettings，与聊天数据、Persona 存档相互独立 ------ */

function getExtensionSettings() {
    try {
        const context = getContext();
        const store = context?.extensionSettings;
        if (store && typeof store === 'object') {
            const raw = store[EXTENSION_SETTINGS_KEY];
            if (!raw || typeof raw !== 'object') {
                store[EXTENSION_SETTINGS_KEY] = { ...DEFAULT_FLOATING_SETTINGS };
            }
            return { ...DEFAULT_FLOATING_SETTINGS, ...store[EXTENSION_SETTINGS_KEY] };
        }
    } catch (error) {
        console.warn(LOG_PREFIX, 'getContext().extensionSettings 读取失败。', error);
    }
    return { ...DEFAULT_FLOATING_SETTINGS };
}

function saveExtensionSettings(patch) {
    try {
        const context = getContext();
        const store = context?.extensionSettings;
        if (!store || typeof store !== 'object') {
            console.warn(LOG_PREFIX, 'extensionSettings 不可用，悬浮窗设置未保存。');
            return;
        }
        store[EXTENSION_SETTINGS_KEY] = { ...getExtensionSettings(), ...patch };
        const save = context?.saveSettingsDebounced;
        if (typeof save === 'function') {
            save.call(context);
        } else {
            console.warn(LOG_PREFIX, '当前版本没有 saveSettingsDebounced，悬浮窗设置仅保留在内存。');
        }
    } catch (error) {
        console.warn(LOG_PREFIX, '保存悬浮窗设置失败。', error);
    }
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
    floatingFieldsSaver?.cancel?.();
    saveOverlayData({ nickname: item.nickname, content: item.content });
    $('#upo_nickname').val(item.nickname);
    $('#upo_content').val(item.content);
    refreshInjection();
    updatePreview();
    syncFloatingPanel();
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

function buildPlanText(plan) {
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
    return plan.followed
        ? `已跟随原生 Persona 位置（镜像） — ${details}`
        : `跟随不可用，已回退到手动配置 — ${details}`;
}

function updatePlanInfo(plan) {
    $('#upo_plan_info').text(buildPlanText(plan));
}

function updateFloatingPlanText(plan) {
    $('#upo_float_plan').text(buildPlanText(plan));
}

function refreshFollowManually() {
    // 手动强制同步：重新读取原生 Persona 生效配置并重算注入计划；不修改原生 Persona。
    lastFollowWarnSignature = '';
    refreshInjection();
    updatePreview();
    notify('已重新读取原生 Persona 配置并刷新 Follow 状态。', 'info');
}

function updatePreview() {
    const data = getOverlayData();
    const plan = resolveInjectionPlan(data);
    const text = buildInjectionText(data);
    $('#upo_preview').val(text || '（当前不会注入任何内容：未启用或内容为空）');
    updatePlanInfo(plan);
    updateFloatingPlanText(plan);
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
        const enabled = Boolean(this.checked);
        saveOverlayData({ enabled });
        $('#upo_float_enabled').prop('checked', enabled);
        refreshInjection();
        updatePreview();
    });

    textFieldsSaver = debounce(() => {
        const nickname = String($('#upo_nickname').val() ?? '');
        const content = String($('#upo_content').val() ?? '');
        saveOverlayData({ nickname, content });
        syncAllTextFields(nickname, content);
        refreshInjection();
        updatePreview();
    }, TEXT_DEBOUNCE_MS);

    $('#upo_nickname, #upo_content').on('input', () => textFieldsSaver());

    $('#upo_lib_save').on('click', saveCurrentToLibrary);

    $('#upo_follow_refresh').on('click', refreshFollowManually);

    $('#upo_lib_edit_save').on('click', saveLibraryEditor);
    $('#upo_lib_edit_cancel').on('click', closeLibraryEditor);

    $('#upo_floating_enabled').on('change', function () {
        const enabled = Boolean(this.checked);
        saveExtensionSettings({ floatingEnabled: enabled });
        if (enabled) {
            createFloatingUI();
        } else {
            destroyFloatingUI();
        }
    });

    $('#upo_floating_icon').on('change', function () {
        saveExtensionSettings({ floatingIcon: this.value === 'plain' ? 'plain' : 'kirimi' });
        updateFloatingIconAppearance();
    });

    $('#upo_floating_size').on('change', function () {
        const size = FLOATING_SIZES[this.value] ? this.value : 'medium';
        saveExtensionSettings({ floatingSize: size });
        updateFloatingIconAppearance();
    });
}

/* ------------ 悬浮窗层：纯 UI 壳，数据仍走 saveOverlayData 与现有 Follow 链 ------------ */

function getFloatingSizePx() {
    const size = getExtensionSettings().floatingSize;
    return FLOATING_SIZES[size] ?? FLOATING_SIZES.medium;
}

function clampIconPosition(left, top, size) {
    const maxLeft = Math.max(0, window.innerWidth - size);
    const maxTop = Math.max(0, window.innerHeight - size);
    return {
        left: Math.min(Math.max(left, 0), maxLeft),
        top: Math.min(Math.max(top, 0), maxTop),
    };
}

function applyIconPosition() {
    const icon = document.getElementById('upo_float_icon');
    if (!icon) {
        return;
    }
    const size = getFloatingSizePx();
    const position = getExtensionSettings().floatingPosition;
    let left;
    let top;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        left = position.x * window.innerWidth;
        top = position.y * window.innerHeight;
    } else {
        // 默认：右侧偏下，避开酒馆顶部按钮区。
        left = window.innerWidth - size - 16;
        top = window.innerHeight * 0.55;
    }
    const clamped = clampIconPosition(left, top, size);
    icon.style.left = `${clamped.left}px`;
    icon.style.top = `${clamped.top}px`;
}

function persistIconPosition() {
    const icon = document.getElementById('upo_float_icon');
    if (!icon) {
        return;
    }
    const left = Number.parseFloat(icon.style.left) || 0;
    const top = Number.parseFloat(icon.style.top) || 0;
    saveExtensionSettings({
        floatingPosition: {
            x: left / window.innerWidth,
            y: top / window.innerHeight,
        },
    });
}

function updateFloatingIconAppearance() {
    const icon = $('#upo_float_icon');
    if (!icon.length) {
        return;
    }
    const settings = getExtensionSettings();
    const size = getFloatingSizePx();
    icon.css({ width: `${size}px`, height: `${size}px` });
    const useKirimi = settings.floatingIcon !== 'plain';
    icon.toggleClass('upo-float-icon-kirimi', useKirimi);
    icon.toggleClass('upo-float-icon-plain', !useKirimi);
    const image = icon.find('img');
    if (useKirimi && !image.length) {
        icon.append($('<img alt="" draggable="false" />').attr('src', FLOATING_ICON_URL));
    } else if (!useKirimi && image.length) {
        image.remove();
    }
    applyIconPosition();
}

function getFloatingTheme() {
    return getExtensionSettings().floatingTheme === 'dark' ? 'dark' : 'light';
}

function applyFloatingTheme() {
    const theme = getFloatingTheme();
    $('#upo_float_panel').toggleClass('upo-float-dark', theme === 'dark');
    const button = $('#upo_float_theme');
    const label = theme === 'dark' ? '切换日间模式' : '切换夜晚模式';
    button.text(theme === 'dark' ? '☀' : '☾');
    button.attr('title', label);
    button.attr('aria-label', label);
    button.attr('aria-pressed', theme === 'dark' ? 'true' : 'false');
}

function renderFloatingTemplateList() {
    const list = $('#upo_float_tpl_list');
    if (!list.length) {
        return;
    }
    list.empty();
    const library = loadLibrary();
    if (!library.length) {
        list.append($('<div class="upo-float-tpl-empty upo-hint"></div>').text('暂无保存的 Persona 模板'));
        return;
    }
    library.forEach(item => {
        const button = $('<button type="button" class="upo-float-tpl-item"></button>').text(item.name);
        button.on('click', () => {
            applyLibraryPersona(item.id);
            renderFloatingTemplateList();
        });
        list.append(button);
    });
}

function syncFloatingPanel() {
    if (!$('#upo_float_panel').length) {
        return;
    }
    const data = getOverlayData();
    $('#upo_float_enabled').prop('checked', data.enabled);
    $('#upo_float_nickname').val(data.nickname);
    $('#upo_float_content').val(data.content);
    updateFloatingPlanText(resolveInjectionPlan(data));
}

function syncAllTextFields(nickname, content) {
    $('#upo_nickname, #upo_float_nickname').val(nickname);
    $('#upo_content, #upo_float_content').val(content);
}

function toggleFloatingPanel(force) {
    const panel = $('#upo_float_panel');
    if (!panel.length) {
        return;
    }
    const shouldOpen = typeof force === 'boolean' ? force : panel.is(':hidden');
    if (shouldOpen) {
        syncFloatingPanel();
        panel.show();
    } else {
        // 关闭前把尚在防抖窗口内的悬浮编辑落盘，避免丢失。
        floatingFieldsSaver?.flush?.();
        panel.hide();
    }
}

function onFloatingViewportResize() {
    applyIconPosition();
}

function createFloatingUI() {
    if (document.getElementById('upo_floating_root')) {
        return;
    }
    const root = $('<div id="upo_floating_root"></div>');
    const icon = $('<div id="upo_float_icon" role="button" aria-label="User Persona Overlay"></div>');
    const panel = $(`
        <div id="upo_float_panel" style="display: none;">
            <div class="upo-float-header">
                <span class="upo-float-title">User Persona Overlay</span>
                <div class="upo-float-actions">
                    <button id="upo_float_theme" type="button" title="切换夜晚模式" aria-label="切换夜晚模式">☾</button>
                    <button id="upo_float_close" type="button" aria-label="关闭">×</button>
                </div>
            </div>
            <div class="upo-float-body">
                <label class="checkbox_label" for="upo_float_enabled">
                    <input id="upo_float_enabled" type="checkbox" />
                    <span data-i18n="当前聊天启用补充 Persona">当前聊天启用补充 Persona</span>
                </label>
                <label class="upo-label" for="upo_float_nickname" data-i18n="备注名 / 昵称">备注名 / 昵称</label>
                <input id="upo_float_nickname" class="text_pole" type="text" maxlength="100" />
                <label class="upo-label" for="upo_float_content" data-i18n="补充 Persona 内容">补充 Persona 内容</label>
                <textarea id="upo_float_content" class="text_pole" rows="6"></textarea>
                <small id="upo_float_plan" class="upo-hint"></small>
                <input id="upo_float_refresh" type="button" class="menu_button" value="刷新 Follow" data-i18n="刷新 Follow" />
                <input id="upo_float_tpl_toggle" type="button" class="menu_button" value="应用模板" data-i18n="应用模板" />
                <div id="upo_float_tpl_list" class="upo-float-tpl-list" style="display: none;"></div>
            </div>
        </div>
    `);
    root.append(icon, panel);
    $('body').append(root);
    updateFloatingIconAppearance();
    applyFloatingTheme();
    bindFloatingEvents();
    window.addEventListener('resize', onFloatingViewportResize);
}

function destroyFloatingUI() {
    // 关闭前把尚在防抖窗口内的悬浮编辑落盘，避免丢失。
    floatingFieldsSaver?.flush?.();
    window.removeEventListener('resize', onFloatingViewportResize);
    $('#upo_floating_root').remove();
}

function bindFloatingIconDrag(icon) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let activePointerId = null;
    let moved = false;

    icon.addEventListener('pointerdown', (event) => {
        if (activePointerId !== null) {
            return;
        }
        activePointerId = event.pointerId;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = Number.parseFloat(icon.style.left) || 0;
        startTop = Number.parseFloat(icon.style.top) || 0;
        icon.setPointerCapture?.(activePointerId);
    });

    icon.addEventListener('pointermove', (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (!moved && Math.hypot(deltaX, deltaY) < FLOATING_DRAG_THRESHOLD_PX) {
            return;
        }
        moved = true;
        const clamped = clampIconPosition(startLeft + deltaX, startTop + deltaY, getFloatingSizePx());
        icon.style.left = `${clamped.left}px`;
        icon.style.top = `${clamped.top}px`;
    });

    const finish = (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }
        icon.releasePointerCapture?.(activePointerId);
        activePointerId = null;
        if (moved) {
            moved = false;
            persistIconPosition();
        } else if (event.type === 'pointerup') {
            // 未发生位移的短按 = 点击：展开/收起悬浮窗。
            toggleFloatingPanel();
        }
    };

    icon.addEventListener('pointerup', finish);
    icon.addEventListener('pointercancel', finish);
}

function bindFloatingEvents() {
    const icon = document.getElementById('upo_float_icon');
    if (icon) {
        bindFloatingIconDrag(icon);
    }

    $('#upo_float_close').on('click', () => toggleFloatingPanel(false));

    $('#upo_float_enabled').on('change', function () {
        const enabled = Boolean(this.checked);
        saveOverlayData({ enabled });
        $('#upo_enabled').prop('checked', enabled);
        refreshInjection();
        updatePreview();
    });

    floatingFieldsSaver = debounce(() => {
        const nickname = String($('#upo_float_nickname').val() ?? '');
        const content = String($('#upo_float_content').val() ?? '');
        saveOverlayData({ nickname, content });
        syncAllTextFields(nickname, content);
        refreshInjection();
        updatePreview();
    }, TEXT_DEBOUNCE_MS);

    $('#upo_float_nickname, #upo_float_content').on('input', () => floatingFieldsSaver());

    $('#upo_float_refresh').on('click', refreshFollowManually);

    $('#upo_float_theme').on('click', () => {
        const next = getFloatingTheme() === 'dark' ? 'light' : 'dark';
        saveExtensionSettings({ floatingTheme: next });
        applyFloatingTheme();
    });

    $('#upo_float_tpl_toggle').on('click', () => {
        const list = $('#upo_float_tpl_list');
        if (list.is(':hidden')) {
            renderFloatingTemplateList();
            list.show();
        } else {
            list.hide();
        }
    });
}

function loadFloatingSettingsIntoPanel() {
    const settings = getExtensionSettings();
    $('#upo_floating_enabled').prop('checked', Boolean(settings.floatingEnabled));
    $('#upo_floating_icon').val(settings.floatingIcon === 'plain' ? 'plain' : 'kirimi');
    $('#upo_floating_size').val(FLOATING_SIZES[settings.floatingSize] ? settings.floatingSize : 'medium');
}

/* ---------------- 事件 ---------------- */

function registerEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 丢弃尚在防抖窗口内的旧文本，避免写进新聊天的元数据。
        textFieldsSaver?.cancel?.();
        floatingFieldsSaver?.cancel?.();
        loadOverlayIntoPanel();
        syncFloatingPanel();
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
        loadFloatingSettingsIntoPanel();
        if (getExtensionSettings().floatingEnabled) {
            createFloatingUI();
        }
        registerEvents();
        refreshInjection();
        console.log(LOG_PREFIX, '扩展已加载。');
    } catch (error) {
        console.error(LOG_PREFIX, '扩展加载失败。', error);
    }
});
