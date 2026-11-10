// Model service credentials live in the private database settings table
// (server-side only). Environment variables can pre-seed them; the admin page
// can rotate them at runtime. Keys are never returned to the browser.
//
// 存储安全：页面填写的 API Key 先经 vault.mjs 用服务器本地主密钥加密，密文才落库。
// 环境变量 JIANPU_LLM_KEY 优先级最高（适合自建部署直接注入），其次是库里的解密值。
import {seal, unseal, isSealed} from './vault.mjs';
import {validateModelSettings} from './config.mjs';

const KEY = 'model_settings';

export async function configFileFromDb(repo, config) {
  try {
    const saved = await repo.setting(KEY);
    if (saved && typeof saved === 'object') {
      // 环境变量已提供时不覆盖，保证运维注入的密钥优先
      const next = {...config.llm};
      if (saved.baseUrl && !config.llmEnv?.baseUrl) next.baseUrl = saved.baseUrl;
      if (saved.model && !config.llmEnv?.model) next.model = saved.model;
      if (!config.llmEnv?.apiKey && saved.apiKey) {
        const plain = isSealed(saved.apiKey) ? unseal(saved.apiKey) : saved.apiKey;
        if (plain) next.apiKey = plain;
        else console.error(JSON.stringify({event: 'apikey_unseal_failed'}));
      }
      if (next.baseUrl) validateModelSettings({...next, apiKey: next.apiKey || undefined});
      config.llm = next;
    }
  } catch (error) {
    console.error(JSON.stringify({event: 'settings_load_failed', code: error.code || 'FAILED'}));
  }
  config.modelHealth.status = config.llm.apiKey ? 'pending' : 'unconfigured';
  return config;
}

export async function saveConfigToDb(repo, settings, config) {
  const next = {...config.llm, ...settings};
  // 入库前加密：数据库里只留密文
  const stored = next.apiKey ? seal(next.apiKey) : '';
  await repo.setSetting(KEY, {baseUrl: next.baseUrl, model: next.model, apiKey: stored});
  config.llm = next;
  config.modelHealth = {status: 'pending', checkedAt: null, message: '配置已保存，尚未验证'};
  return config;
}
