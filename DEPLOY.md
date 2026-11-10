# 部署与账号管理

## 已配置的发布路径

源码仓库：https://github.com/Yang-Sir888/yi_jian_chu_pu

网站使用 Sites 托管的 Cloudflare Worker，数据库 D1、私有音频 R2。项目标识在 .openai/hosting.json。站点发布状态和实际访问链接以当前交付结果为准，GitHub 仓库地址不是专家登录入口。

- cloud/worker.mjs：与现有前端兼容的云端 API。
- cloud/migrations/：数据库迁移。build-cloud.mjs 将其复制到 drizzle/，Sites 发布时应用。
- dist/server/index.js：构建出的 Worker；dist/client：前端和本地识别模型。
- 管理员 admin：首次登录改密，再在“账号与模型管理”配置百炼。
- 评审专家 expert01：专用有限权限账号，可直接体验，不需要配置密钥。
- 密码是随机生成的部署秘密，不在源码、文档或构建中公开。由项目所有者保管交付记录。

站点允许外部访问，平台内仍要求账号登录。专家账号只能访问该账号的作品；多人共用同一账号会共享该账号的作品，若需分别保密，请由管理员创建独立账号。

## 必要的云端环境秘密

| 名称 | 用途 |
|---|---|
| ADMIN_PASSWORD | 首次创建管理员的密码（只在账号不存在时使用） |
| EXPERT_PASSWORD | 首次创建 expert01 的密码（只在账号不存在时使用） |
| MODEL_VAULT_KEY | 32字节随机密钥的 base64 编码，用于 AES-GCM 加密百炼密钥 |
| MAX_MODEL_CALLS_PER_DAY | 全站每日付费模型请求上限，目前配置100，含连接测试 |
| MAX_STORAGE_MB | 私有音频总容量限制，未配置时4096 |
| MAX_MODEL_CONCURRENCY | 全站模型并发上限，最大2 |

环境秘密通过 Sites 原生环境变量工具设置，不能写入 .openai/hosting.json 或前端。数据库与加密主密钥必须同时保留；换主密钥后旧密文无法解密，需要管理员重填百炼密钥。重新部署保留数据库中的账号、密码、作品与配置，不会按环境值重置已有账号。

百炼调用经 HTTPS 服务端代理，Base URL 仅允许官方 OpenAI兼容域名和标准端口。密钥加密后入库，管理接口只返回是否配置。模型请求禁止重定向，有超时、并发、账号限流和持久化日额度；这不能替代供应商侧余额预算和账单检查。

## 更新云端

安装根目录、backend、frontend 各自依赖后运行：

```sh
npm test
npm --prefix frontend test
npm run build
```

通过 Sites 技能 source workflow 推送相同源码并打包，随后保存版本、发布并确认终态成功。发布包必须与推送的 commit 对应；不能只更新 GitHub 就认为线上已更新。数据库迁移上线后不可修改历史迁移，应增加新迁移。

## 本地与独立服务器

Node.js22+。无需独立数据库的启动方式：

```sh
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix frontend run build
npm start
```

随机账号记录：.lingpu/setup-credentials.json。反复运行保留原记录。默认库 backend/.data/postgres；设置 DATA_DIR 后使用 DATA_DIR/postgres 和 DATA_DIR/.model-vault.key，账号记录也放该目录。

Docker：docker compose up --build -d。账号记录可在容器 /data/setup-credentials.json 查看。初始密码不会打印到公开服务日志。容器数据卷必须持久化。Docker 构建文件已提供；当前开发环境没有 Docker，不能声称已实测容器构建。

若部署反向代理，设置 APP_ORIGIN 为外部 HTTPS 地址、TRUST_PROXY 为实际可信代理跳数，代理上传上限至少25MB、响应超时至少60秒。默认仅 HTTP 本机演示。公网应配置 HTTPS，Cookie 在 HTTPS 自动标记 Secure。没有域名和服务器时优先使用本次托管站点。

嵌入式 PGlite 只允许一个进程持有同一数据目录，不适合多副本。需要多实例时设置独立 PostgreSQL DATABASE_URL，其他服务配置不变。停止本地服务后再运行维护CLI。冷备份需完整复制数据目录及主密钥；独立PostgreSQL可 pg_dump，同时备份主密钥。

## 成本与可用性

- 音符识别在访问者设备CPU运行；网页/模型下载产生托管流量，识别速度受设备影响。
- 百炼连接测试和文字整理可能收费，以阿里云账单为准。没有文字要求不调用百炼。
- 网站运行依赖托管服务，不能承诺永久免费或中国大陆任意网络可达；提交前应让另一台设备及评审使用的网络实际访问。
- Render 作为替代支持Docker，但免费Web实例15分钟无流量会休眠且不能挂持久盘，不能把免费临时磁盘用于本项目数据。付费/地区及最新规则见官方文档：https://render.com/docs/free 、https://render.com/docs/disks 。
- 共享评审账号密码可能被评审修改，请在正式提交前核对密码，并为不同评审创建独立账号或通过管理员重置。

## 比赛交付边界

软件测试和合成信号不等于真实民族音乐准确率。实际评审材料还需真实授权样本、专家参考谱、误差/耗时结果、PPT和演示视频。相关规范及赛程依据见 docs/评审改进与证据.md。
