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
    followPersona: false,
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
        followPersona: Boolean(raw.followPersona),
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

function updatePlanInfo(data, plan) {
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
    let text;
    if (data.followPersona) {
        text = plan.followed
            ? `已跟随原生 Persona 位置（镜像） — ${details}`
            : `跟随不可用，已回退到手动配置 — ${details}`;
    } else {
        text = `手动配置 — ${details}`;
    }
    $('#upo_plan_info').text(text);
}

function updatePreview() {
    const data = getOverlayData();
    const plan = resolveInjectionPlan(data);
    const text = buildInjectionText(data);
    $('#upo_preview').val(text || '（当前不会注入任何内容：未启用或内容为空）');
    updatePlanInfo(data, plan);
    updateStateBadge();
}

function toggleDepthRow() {
    const data = getOverlayData();
    $('#upo_depth_row').toggle(!data.followPersona && data.position === extension_prompt_types.IN_CHAT);
    $('#upo_role_row').toggle(!data.followPersona);
}

function loadOverlayIntoPanel() {
    const data = getOverlayData();
    $('#upo_enabled').prop('checked', data.enabled);
    $('#upo_nickname').val(data.nickname);
    $('#upo_content').val(data.content);
    $('#upo_position').val(data.followPersona ? 'follow' : String(data.position));
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
        if (this.value === 'follow') {
            saveOverlayData({ followPersona: true });
        } else {
            saveOverlayData({ followPersona: false, position: normalizePosition(this.value) });
        }
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
        loadOverlayIntoPanel();
        registerEvents();
        refreshInjection();
        console.log(LOG_PREFIX, '扩展已加载。');
    } catch (error) {
        console.error(LOG_PREFIX, '扩展加载失败。', error);
    }
});
