# User Persona Overlay

SillyTavern 第三方扩展：为**当前聊天**额外提供一份独立的「补充 User Persona」，仅在生成回复时临时注入给模型。

它与 SillyTavern 原生 Persona 完全独立：

- 不修改原生 Persona
- 不修改角色卡
- 不修改聊天历史 / `chat` 数组
- 生成结束后不留下任何额外消息

## 功能（MVP）

- 每个聊天独立保存补充 Persona，切换聊天自动读取，互不干扰
- 启用 / 禁用
- 自定义备注名 / 昵称
- 补充 Persona 内容编辑（输入后 300ms 防抖自动保存）
- 注入位置：系统提示区（IN_PROMPT）/ 聊天内指定深度（IN_CHAT）/ 提示词最前（BEFORE_PROMPT）
- 注入位置可选「跟随原生 Persona 位置（镜像）」：只读镜像原生 Persona 的位置参数（详见下文同名章节）
- 注入深度 depth（仅 IN_CHAT 时生效）
- 注入角色：System / User / Assistant
- 注入内容实时预览 + 当前聊天状态徽标

## 安装

### 方式一：酒馆界面安装（推荐）

1. 打开 SillyTavern → 扩展面板 → Install Extension（安装扩展）
2. 填入仓库地址：`https://github.com/songyu4echo1106-code/user-persona-overlay.git`
3. 安装完成后刷新页面（F5）

### 方式二：手动安装

把本仓库克隆到酒馆的第三方扩展目录，**目录名必须是 `user-persona-overlay`**（模板按此路径加载）：

```bash
# 新版（用户数据目录模式，<用户句柄> 默认为 default-user）
git clone https://github.com/songyu4echo1106-code/user-persona-overlay.git "data/<用户句柄>/extensions/user-persona-overlay"

# 旧版（public 目录模式）
git clone https://github.com/songyu4echo1106-code/user-persona-overlay.git "public/scripts/extensions/third-party/user-persona-overlay"
```

然后重启 / 刷新酒馆，在扩展面板中应能看到 **User Persona Overlay**。

## 使用

1. 打开任意聊天。
2. 扩展面板 → User Persona Overlay。
3. 勾选「为当前聊天启用补充 Persona」，填写昵称与内容。
4. 预览框实时显示最终注入文本；生成回复时该文本会临时加入提示词。

## 数据存储

数据保存在**当前聊天的元数据**（`chatMetadata`，随聊天文件持久化）中，键名 `user_persona_overlay`：

```json
{
    "version": 1,
    "enabled": false,
    "followPersona": false,
    "nickname": "",
    "content": "",
    "position": 1,
    "depth": 2,
    "role": 0
}
```

| 字段 | 含义 |
| --- | --- |
| `enabled` | 是否为当前聊天启用注入 |
| `followPersona` | 是否跟随原生 Persona 位置（镜像）；读取失败时回退到手动 `position` / `depth` / `role` |
| `nickname` | 备注名 / 昵称，会写入注入文本头部 |
| `content` | 补充 Persona 正文 |
| `position` | 1 = IN_PROMPT，2 = IN_CHAT，3 = BEFORE_PROMPT |
| `depth` | 仅 IN_CHAT 生效，0 = 聊天最底部 |
| `role` | 0 = System，1 = User，2 = Assistant |

清除某个聊天的数据：取消启用并清空内容即可；残留的只是一个空配置对象，不会被注入。

## 注入机制

仅使用官方 `setExtensionPrompt(name, value, position, depth, scan, role)`（内存注入，不落盘）：

- 启用且有内容：写入注入文本与所选位置 / 深度 / 角色
- 禁用或内容为空：写入空串且位置置为 `NONE`
- 切换聊天（`CHAT_CHANGED`）时按新聊天数据重设，杜绝串聊天污染
- 生成前（`GENERATION_AFTER_COMMANDS`，若当前版本提供）再刷新一次，保证最新改动生效

**不使用** `generate_interceptor`：它直接操作聊天消息数组，存在污染聊天记录的风险。

## 跟随原生 Persona 位置（镜像）

注入位置选择「跟随原生 Persona 位置（镜像）」后进入 Follow 模式：

- 只读读取当前 SillyTavern 原生 Persona 的 position / depth / role，并通过 `setExtensionPrompt` 把相同参数镜像到本扩展的注入。
- Follow 模式不会修改原生 Persona，也不会写入 `power_user.persona_descriptions`。
- Follow 模式下实际注入参数由原生 Persona 决定，面板中的 depth 与角色控件会隐藏；当前聊天保存的手动配置仍会保留，仅用于回退。

镜像行为按位置区分：

- **IN_CHAT**：镜像原生 Persona 的 depth / role，可以进入相同注入层级；但相同 depth 下的最终消息先后顺序不由本扩展保证。
- **IN_PROMPT**：原生 Persona 与本扩展注入属于独立的 prompt 项。如需严格控制两者的相邻顺序，请在 SillyTavern Prompt Manager 中手动调整。

回退（fallback）：当原生 Persona 无法读取、不存在，或者其位置属于当前 Follow 实现无法镜像的类型时，自动回退到当前聊天保存的手动 position / depth / role，面板会显示「跟随不可用，已回退到手动配置」。这是正常的回退行为，而非扩展报错或功能失效；控制台会输出经过去重的提示。

Persona 切换：扩展已注册 `PERSONA_CHANGED` 监听，原生 Persona 切换后会重新解析并刷新注入计划、状态和预览，不会修改原生 Persona 的任何数据。若当前酒馆版本不提供 `PERSONA_CHANGED` 事件，切换 Persona 后需通过编辑或切换聊天触发刷新。

## 兼容性

最低兼容版本**尚未确定**，`manifest.json` 暂未设置 `minimum_client_version`。本扩展依赖酒馆长期存在的 API（`setExtensionPrompt`、`chatMetadata`、`eventSource` / `event_types`、`renderExtensionTemplateAsync`），实机测试时请确认：

- [ ] 面板正常出现在扩展设置中
- [ ] 切换聊天后内容正确切换、刷新页面后数据仍在
- [ ] Prompt Inspector / 提示词检查器中能看到注入内容
- [ ] `{{user}}` / `{{char}}` 宏在注入文本中是否被替换
- [ ] 群聊中行为是否正常（群聊元数据按群聊文件存储）

确认本机可用后，可再在 `manifest.json` 中补 `minimum_client_version`。

## Roadmap（非 MVP）

- 悬浮窗模式（可拖动、记忆位置、移动端适配），默认图标 `assets/salmon.png`
- 悬浮按钮图标大小调整与自定义图片
- i18n / slash 命令
- 按生成类型（普通 / 继续 / 扮演等）过滤注入
