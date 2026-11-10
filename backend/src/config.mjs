// TRUST_PROXY 直接透传给 Express，但 'true'/'false' 这类字符串会被 proxy-addr 当成 IP 解析而抛错，
// 因此这里先归一化：布尔值→跳数（1）/false，纯数字→数字，其余（如 loopback、子网列表）原样保留。
function parseTrustProxy(raw) {
  const value = (raw ?? '').trim();
  if (!value) return false;
  if (/^true$/i.test(value)) return 1;
  if (/^false$/i.test(value)) return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function configFromEnv(env = process.env) {  const production = env.NODE_ENV === 'production';
  // 平台托管启动时只注入 PORT，站点地址并未注入。这里按「显式配置 → 平台预览端口 →
  // 本地开发」的顺序推导，保证 in-sandbox 启动不会因缺一项配置直接崩溃；
  // 真正上线到独立域名时仍应显式设置 APP_ORIGIN（CSRF/Origin 校验以此为基准）。
  const fallbackOrigin = env.CODESPACE_NAME || env.X_IDE_SPACE_ID
    ? `http://localhost:${env.PREVIEW_PORT || 55221}`
    : `http://localhost:${env.PORT || 3000}`;
  // Render supplies this trusted runtime value after assigning its public URL.
  // It must still pass the same strict URL validation as an explicit origin.
  const renderOrigin = env.RENDER === 'true' ? env.RENDER_EXTERNAL_URL : '';
  const origin = (env.APP_ORIGIN || renderOrigin || fallbackOrigin).replace(/\/+$/, '');
  const config = {
    production,
    origin,
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 3000),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // 额外允许的站点来源（自有域名等），逗号分隔
    extraOrigins: env.APP_EXTRA_ORIGINS || '',
    concurrency: Math.max(1, Math.min(2, Number(env.MAX_MODEL_CONCURRENCY) || 2)),
    maxModelCallsPerDay: Math.max(1, Math.min(100000, Number(env.MAX_MODEL_CALLS_PER_DAY) || 300)),
    maxStorageBytes: Number(env.MAX_STORAGE_MB || 4096) * 1024 * 1024,
    llm: {
      baseUrl: env.JIANPU_LLM_BASE || '',
      model: env.JIANPU_LLM_MODEL || 'qwen-plus',
      apiKey: env.JIANPU_LLM_KEY || '',
      timeoutMs: 45000,
    },
    llmEnv: {baseUrl: !!env.JIANPU_LLM_BASE, model: !!env.JIANPU_LLM_MODEL, apiKey: !!env.JIANPU_LLM_KEY},
    modelHealth: {status: env.JIANPU_LLM_KEY ? 'pending' : 'unconfigured', checkedAt: null, message: ''},
  };
  let originUrl;
  try { originUrl = new URL(config.origin); } catch { throw new Error('APP_ORIGIN 必须是完整的 http/https 站点地址'); }
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password || originUrl.search || originUrl.hash || originUrl.pathname !== '/') {
    throw new Error('APP_ORIGIN 只能包含 http/https 协议、域名和端口');
  }
  config.origin = originUrl.origin;
  if (config.llm.baseUrl) validateModelSettings({...config.llm, ...(config.llm.apiKey ? {} : {apiKey: undefined})});
  return config;
}

export function validateModelSettings(s) {
  if (!s || typeof s.baseUrl !== 'string' || typeof s.model !== 'string' || s.model.length > 120 || !s.model.trim()) {
    throw Object.assign(new Error('请填写接口地址和模型名称'), {status: 400});
  }
  let u;
  try { u = new URL(s.baseUrl); } catch { throw Object.assign(new Error('接口地址格式不正确'), {status: 400}); }
  const dashscopeCompatible = u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.search && !u.hash
    && u.pathname.replace(/\/$/, '').endsWith('/compatible-mode/v1')
    && (/^([a-z0-9-]+\.)*maas\.aliyuncs\.com$/i.test(u.hostname) || /^dashscope(?:-intl|-us)?\.aliyuncs\.com$/i.test(u.hostname));
  if (!dashscopeCompatible) {
    throw Object.assign(new Error('请复制百炼控制台的 OpenAI 兼容 HTTPS Base URL，末尾为 /compatible-mode/v1'), {status: 400});
  }
  if (s.apiKey !== undefined && (typeof s.apiKey !== 'string' || s.apiKey.length < 16 || s.apiKey.length > 500 || /[\s*]/.test(s.apiKey))) {
    throw Object.assign(new Error('请填完整密钥，不能使用截图中的打码值'), {status: 400});
  }
  return {baseUrl: u.href.replace(/\/$/, ''), model: s.model.trim(), ...(s.apiKey ? {apiKey: s.apiKey} : {})};
}
