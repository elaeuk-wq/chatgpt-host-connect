// UI labels, English + Chinese. Matching is case-insensitive and whitespace-
// normalised; exact text beats prefix beats substring. "/.../" entries are regexes.
// Extend at run time with --labels my-labels.json (same shape, arrays are appended).

export const LABELS = {
  common: {
    login: ['Log in', 'Sign in', 'Continue with Google', '登录', '登入', '继续使用 Google'],
    captcha: ['Verify you are human', 'I am human', '确认您是真人', '验证你是人类', '人机验证'],
    payment: ['Upgrade plan', 'Add payment method', 'Billing', '升级套餐', '添加付款方式', '账单'],
    close: ['Close', 'Cancel', '关闭', '取消'],
    done: ['Done', 'Close', 'OK', '完成', '关闭', '好的'],
    save: ['Save', 'Save changes', 'Update', '保存', '保存更改', '更新'],
    edit: ['Edit', 'Edit tunnel', '编辑', '编辑隧道'],
    more: ['More', 'More options', 'Actions', '/^(…|\\.\\.\\.|⋯)$/', '更多', '更多选项', '操作'],
  },

  platform: {
    createTunnel: ['Create tunnel', 'New tunnel', 'Create', '创建隧道', '新建隧道'],
    tunnelName: ['Name', 'Tunnel name', '名称', '隧道名称'],
    tunnelDescription: ['Description', '描述', '说明'],
    workspaceField: ['Search workspaces by name or ID', 'ChatGPT workspaces', 'ChatGPT workspace', 'Workspaces', '按名称或 ID 搜索工作区', 'ChatGPT 工作区', '工作区'],
    createSubmit: ['Create', 'Create tunnel', '创建', '创建隧道'],
    createKey: ['Create new secret key', 'Create secret key', '+ Create new secret key', '创建新的密钥', '创建新密钥', '创建密钥'],
    keyName: ['Name', 'Name (optional)', '名称', '名称（可选）'],
    project: ['Project', '项目'],
    defaultProject: ['Default project', '默认项目'],
    allSelected: ['All selected', '全部已选', '已全选'],
    restricted: ['Restricted', '受限', '限制'],
    tunnelsRow: ['Tunnels', '隧道'],
    tunnelsReadUse: ['Read + Use', 'Read & Use', 'Read and use', 'Read, Use', '读取 + 使用', '读取和使用', '读取 + 使用权限'],
    tunnelsUse: ['Use', '使用'],
    tunnelsRead: ['Read', '读取'],
    noneValue: ['None', '无'],
    expiry: ['Expiration', 'Expires', 'Expiry', 'Key expiration', '有效期', '过期时间', '到期'],
    expiry30: ['30 days', '30 天', '30天'],
    createKeySubmit: ['Create secret key', 'Create key', 'Create', '创建密钥', '创建'],
    saveKeyTitle: ['Save your key', 'Save your secret key', '保存你的密钥', '保存您的密钥'],
  },

  muse: {
    newChat: ['New chat', 'New task', 'New conversation', '新对话', '新建对话', '新任务', '新聊天'],
    composer: ['Message', 'Ask anything', 'Send a message', '发消息', '输入消息', '给 Muse 发消息', '有什么可以帮你'],
    attach: ['Attach', 'Attach files', 'Upload', 'Add files', '添加附件', '上传文件', '附件', '上传'],
    send: ['Send', 'Send message', '发送', '发送消息'],
    reviewBadge: ['Needs review', 'Review required', 'Pending review', '需要审核', '待审核'],
    reviewButton: ['Review', '审核'],
    allowOnce: ['Allow once', '允许一次'],
    allowAny: ['Allow once', 'Allow', 'Always allow', '允许一次', '允许', '始终允许', '总是允许'],
    moreAllow: ['More allow options', 'More options', '更多允许选项'],
    alwaysAllowSite: ['Always allow this site', 'Always allow this website', 'Always allow', '总是允许此站点', '始终允许此站点', '始终允许此网站', '总是允许'],
    alwaysAllow: ['Always allow', '始终允许', '总是允许'],
  },

  chatgpt: {
    add: ['Add', 'Add plugin', 'Create', '添加', '新建'],
    addCustomMcp: ['Add custom MCP server', 'Custom MCP server', 'Add MCP server', '添加自定义 MCP 服务器', '自定义 MCP 服务器'],
    name: ['Name', '名称'],
    connection: ['Connection', 'Connect via', '连接', '连接方式'],
    tunnel: ['Tunnel', '隧道'],
    tunnelIdField: ['Tunnel ID', '/^tunnel_/', '隧道 ID'],
    auth: ['Authentication', 'Auth', '身份验证', '认证'],
    noAuth: ['No authentication', 'No auth', 'None', '无需身份验证', '无身份验证', '无'],
    understand: ['I understand and want to continue', 'I understand', '我已了解，并希望继续', '我已了解'],
    create: ['Create as plugin', 'Create plugin', 'Create', '创建为插件', '创建插件', '创建'],
    connect: ['Connect', '连接'],
    nameTaken: ['already exists', 'name is taken', '已存在同名应用', '已存在'],
    rateLimited: ['rate limit', 'rate-limited', '速率限制'],
    installed: ['Installed', '已安装'],
    connected: ['Connected', '已连接'],
    composer: ['Ask anything', 'Message ChatGPT', '询问任何问题', '给 ChatGPT 发送消息', '有问题，尽管问'],
    send: ['Send prompt', 'Send', '发送提示', '发送'],
    alwaysAllow: ['Always allow', '始终允许', '总是允许'],
    allow: ['Allow', 'Confirm', 'Approve', '允许', '确认', '批准'],
    newChat: ['New chat', '新聊天', '新对话'],
  },
};

// Known stable selectors, tried before label matching.
export const SELECTORS = {
  chatgptComposer: '#prompt-textarea,[data-testid="prompt-textarea"]',
  chatgptSend: '[data-testid="send-button"],button[aria-label="Send prompt"]',
  chatgptAssistant: '[data-message-author-role="assistant"]',
  composerGeneric: 'textarea,[contenteditable="true"],[role="textbox"]',
};

export function mergeLabels(extra) {
  for (const [site, keys] of Object.entries(extra || {})) {
    LABELS[site] ||= {};
    for (const [k, v] of Object.entries(keys)) LABELS[site][k] = [...(Array.isArray(v) ? v : [v]), ...(LABELS[site][k] || [])];
  }
}
