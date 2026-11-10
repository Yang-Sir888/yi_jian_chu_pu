# 国韵谱音

面向民族音乐资料整理的旋律采谱与专家校订工作台。上传独唱或单乐器录音，生成可校订简谱初稿，对照原音核对后导出 SVG、MusicXML、MIDI 或核验 JSON。

## 能力与边界

- 音符识别：浏览器本地运行 Spotify Basic Pitch；YIN 可主动选为备用，CREPE 仅作实验性复核。模型文件随源码提供。
- 记谱整理：服务端调用阿里云百炼，将明确的文字要求转换成调号、拍号与速度操作。大模型只接收谱面参数和要求，不听原音，也不自动补写旋律。
- 专家校订：点击音符修改音高、时值、歌词、连音，原谱和修改后谱面分别保留；可点选原音片段核对。
- 可复现演示：内置已知音高的合成校验 WAV，可真实进入识别流程；另有明确标注的示例谱，二者不可混称真实录音实验。
- 访问与共享配置：账号隔离作品；仅管理员可填写百炼 Base URL、模型名和密钥。密钥在服务端加密保存，其他使用者不用填写。

优先适用于清晰、短时、单旋律录音。伴奏、多人合唱、强混响、噪声、滑音、装饰音及非十二平均律音高会影响结果。它不能可靠完成混音主旋律分离、微分音还原或民族/地区自动判别。疑点比例是规则提示，**不是经过测试集验证的准确率**。

## 本地运行

需要 Node.js 22 或更新版本，首次安装需要联网：

```sh
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix frontend run build
npm start
```

访问 http://localhost:3000 。首次启动自动初始化管理员 admin 和专家 expert01；随机初始密码保存在本机 .lingpu/setup-credentials.json，不要公开或上传该文件。首次登录需要改密。重复启动保留账号和作品。

默认使用持久化 PGlite（真实 PostgreSQL 引擎），无需另装数据库。数据位于 backend/.data/postgres，加密主密钥默认在 backend/.model-vault.key。设置 DATA_DIR 后数据库和主密钥均放在该持久目录。它适合一个服务进程；多副本部署应使用独立 PostgreSQL 并设置 DATABASE_URL。运行期间不要另开维护脚本访问同一嵌入式数据库。

生产环境必须使用 HTTPS。按 backend/.env.example 配置实际 APP_ORIGIN、代理信任和存储/调用限额；秘密环境文件不得提交 Git。

## 评审演示顺序

1. 登录专家账号，载入合成校验音频，点击一键出谱；该音频会经过真实识别。
2. 点击音符试听原音，修改一处音高或歌词，保存后从作品列表重新打开。
3. 导出 MusicXML、MIDI 和核验记录；核验记录包含初稿与校订谱。
4. 管理员接通百炼后试用三条要求：“按 1=D 记谱，保持实际音高”“按 3/4 拍重新分小节”“将谱面速度设为每分钟 84 拍”。

更改记谱调号保持实际音高，不等于真正的音乐移调。按拍整理涉及量化，散板建议选自由时长并人工核对。

## 云端与 GitHub

GitHub 保存源码并运行构建检查；GitHub Pages 不运行本平台的鉴权、数据库或密钥代理。云端适配器位于 cloud/，使用 Worker、D1 和私有 R2；.openai/hosting.json 记录 Sites 项目。Docker 部署保留 Express 及 PGlite/外部 PostgreSQL。

```sh
npm ci
npm --prefix backend ci
npm --prefix frontend ci
npm test
npm run build
```

Docker：docker compose up --build -d，数据卷必须保留。详情见 [部署说明](DEPLOY.md)。免费短暂文件系统不可作为账号、作品、密钥的持久存储。

## 密钥与成本

在管理员“账号与模型管理”填写百炼控制台 OpenAI 兼容 HTTPS Base URL（结尾 /compatible-mode/v1）、有权限的模型名和完整密钥，保存后测试连接。不要填写截图中的打码值。只有服务器调用模型，接口不回传密钥。全站有持久化日调用上限，云端目前配置 100 次/日；本地默认及配置见 backend/.env.example。

音符识别和导出不调用百炼；文字整理及连接测试可能产生供应商费用。录音在浏览器内识别，点击保存才上传至部署服务私有存储。首次访问仍需网络加载网页和模型；登录、保存、重开需要服务在线，不能称为“全平台离线”。具体账单以供应商控制台为准。

## 目录与证据

- frontend/：React + TypeScript、模型 Worker、简谱编辑、播放与导出。
- backend/：Express、PGlite/PostgreSQL、服务端保险箱和本地部署。
- cloud/：兼容 API、D1 迁移和测试。
- docs/评审改进与证据.md：比赛材料核验、专家视角缺口和实验建议。
- .github/workflows/check.yml：源码测试和生产构建。

合成样例与软件测试证明流程和格式可运行，不能证明真实民族音乐语料的普遍转谱质量。参赛前仍需有授权的真实录音、独立测试集及音符 F1、时间容差、人工校订耗时和失败案例。第三方模型授权见各模型目录 LICENSE。
