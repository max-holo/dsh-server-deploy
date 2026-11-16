# dsh-server-deploy

[![npm](https://img.shields.io/npm/v/dsh-server-deploy.svg)](https://www.npmjs.com/package/dsh-server-deploy)
[![weekly downloads](https://img.shields.io/npm/dw/dsh-server-deploy.svg)](https://www.npmjs.com/package/dsh-server-deploy)

DeepSeek Harness（DSH）插件：在会话里说一句「部署」「发版」「部署到 test/uat/prod」，自动完成 **构建 → 上传 → 备份 → 停服 → 替换文件 / 解压前端 → 启服 → 健康检查**，并把远程命令**实时投影到侧边栏终端**。支持**单机、前端、微服务、集群**四种部署形态，环境名自由（test/uat/prod 均可）。

## 特性

- **一句话部署**：模型调用 `deploy_run`，返回每一步状态与耗时；远程命令实时显示在右侧终端 tab。
- **模型看得见输出**：工具结果带 `outputTail`（终端里同一份日志的最后 2000 字符），失败原因不用再二次翻终端。
- **Agent 终端**（DSH 0.2.2+）：Host 用 `openForAgent` 自己开终端并输入跟随命令，终端跑在会话沙箱内、自动出现在侧栏；旧版 DSH 自动回退到「浏览器 attach 后输入」的老路径。
- **四种部署形态**：单机后端（jar/war）、前端（dist 打 zip 解压）、微服务（`services` 数组，每服务独立服务器/构建/健康检查）、集群（`instances` 多机复制 + `parallel` 并发）。
- **按形态生成模板**：`deploy_config init` 带 `template: single | frontend | services | cluster`，一键生成对应形态的配置骨架。
- **远程操作**：查状态、重启、备份、回滚、执行任意命令（`deploy_remote`），不整体部署时也能用。
- **零本地依赖**：传输层是纯 Node（`ssh2` + `adm-zip`），目标机只需 Linux + SSH，无需 Python。
- **省心细节**：备份自动排除日志、不压缩 tar 更快、保留 N 份、控制脚本（start.sh 等）自动生成、sudo、密码/密钥认证。

## 环境要求

- DSH `>= 0.2.2-0 < 0.3.0`（包内 `engines.dsh` 声明，安装时校验；`-0` 让 0.2.2 的预发布版也算兼容）
- 目标服务器：Linux，SSH 可达
- 本地：无需额外运行时（`ssh2`、`adm-zip` 随 npm 包自动安装）

## 安装

```powershell
dsh plugin --profile web add dsh-server-deploy
```

安装后**重启 dsh web** 生效，验证：

```powershell
dsh --profile web --dump-config
# 组合树里应出现：- id: dsh-deploy / name: dsh-server-deploy
```

## 快速开始

1. **生成配置**：让 DSH 按部署形态生成 `.dsh-deploy.json`——对模型说「初始化部署配置，微服务/集群/前端/单机」，对应 `deploy_config init` 的 `template` 参数（默认 single），再填真实服务器信息。
2. **部署**：在项目目录打开 DSH 会话，输入「部署到 test / uat / prod」（只配一个环境时直接说「部署」）。
3. **日常运维**：「看一下 test 环境服务状态」「重启 prod」「回滚到上一个备份」「第 2 台机器单独重启」（集群用 `instance`）。

### 部署形态一览

| 形态 | template | 关键配置 | 说明 |
| --- | --- | --- | --- |
| 单机后端 | `single` | `type: "backend"` + `artifacts` | 一个 jar/war 部署到一台机器，systemctl 启停 |
| 前端 | `frontend` | `type: "frontend"` + `package.local` | 本地 dist 打 zip → 上传 → 解压到 nginx 目录，无启停；`remote.clean: true` 解压前清空目录 |
| 微服务 | `services` | `services: [...]` + `parallel` | 每个服务独立 host/构建/产物/健康检查；父级放共享默认，`{{service}}` 占位符替换服务名 |
| 集群 | `cluster` | 服务配 `instances: [...]` | 同一服务多台机器：构建/产物/健康检查共享一份，每台只需 `host` + `remote.deployDir`；`parallel: true` 并发 |

### 配置示例（单服务，后端 jar）

```json
{
  "project": "my-app",
  "environments": {
    "test": {
      "host": "192.168.1.10",
      "username": "deploy",
      "auth": { "type": "password", "password": "你的密码" },
      "type": "backend",
      "build": { "command": "mvn clean package -DskipTests" },
      "artifacts": [{ "local": "target/app.jar", "remote": "app.jar" }],
      "remote": {
        "deployDir": "/opt/my-app",
        "stopCommand": "systemctl stop my-app",
        "startCommand": "systemctl start my-app",
        "healthCheck": { "type": "http", "url": "http://127.0.0.1:8080/actuator/health" }
      }
    }
  }
}
```

前端项目把 `type` 设为 `"frontend"`、用 `package` 指定构建产物目录（自动打 zip 上传解压）：

```json
"type": "frontend",
"package": { "local": "dist", "remoteName": "web.zip" }
```

## 核心配置字段

顶层：`project`、`environments`（环境名 → 环境对象，可配多个）。

| 字段 | 说明 |
| --- | --- |
| `host` / `port` / `username` | 服务器地址、SSH 端口（默认 22）、账号 |
| `auth` | 密码 `{ "type": "password", "password": "..." }` 或密钥 `{ "type": "key", "privateKey": "~/.ssh/id_ed25519", "passphrase": "可选" }`（**推荐**）。`type: key` 不填 `privateKey` 时自动依次找 `~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`，都没有则用 SSH agent（`SSH_AUTH_SOCK`）。微服务/集群中 auth 可配在父级共享，也可按 service / instance 覆盖 |
| `sudo` | `true` 时所有远程命令走 `sudo -S` |
| `type` | `backend`（文件替换）、`frontend`（zip 解压）、`services`（微服务） |
| `build` | `{ "command": "npm run build", "cwd": "front" }`，部署前在本地工作区执行 |
| `artifacts` | 后端产物：`[{ "local": "target/app.jar", "remote": "app.jar" }]`（`local` 相对工作区，`remote` 相对部署目录） |
| `package` | 前端产物：`{ "local": "dist", "remoteName": "web.zip" }`（自动排除 node_modules/.git） |
| `remote.deployDir` | 远程部署目录（必填） |
| `remote.backupDir` | 备份目录，默认 `<deployDir>-backups`；`backupKeep` 保留份数，默认 10 |
| `remote.backupCompress` | 备份是否 gzip，默认 `false`（不压缩更快，回滚效果相同） |
| `remote.stopCommand` / `startCommand` / `statusCommand` | 服务启停/状态命令；也可配 `remote.scripts` 用控制脚本（缺失时按 jar 模板自动生成） |
| `remote.preCommands` / `postCommands` | 部署前后执行的远程命令数组 |
| `remote.healthCheck` | `{ "type": "http", "url": "...", "retries": 10 }` 或 `{ "type": "command", "command": "..." }` |
| `services` / `parallel` / `continueOnError` | 微服务模式：服务列表、并发部署、失败是否继续 |

完整字段（上传并发、解压工具、多实例等）见仓库或让 DSH 在配置时直接生成。

### 微服务示例

```json
{
  "environments": {
    "test": {
      "username": "deploy",
      "auth": { "type": "password", "password": "..." },
      "services": [
        { "name": "api", "host": "192.168.1.11", "build": { "command": "mvn package -DskipTests", "cwd": "api" },
          "artifacts": [{ "local": "api/target/api.jar", "remote": "api.jar" }],
          "remote": { "deployDir": "/opt/api", "stopCommand": "systemctl stop api", "startCommand": "systemctl start api" } },
        { "name": "web", "host": "192.168.1.12", "type": "frontend",
          "package": { "local": "web/dist", "remoteName": "web.zip" },
          "remote": { "deployDir": "/opt/web" } }
      ],
      "parallel": true
    }
  }
}
```

### 集群示例（同一服务 × 多台机器）

```json
{
  "environments": {
    "prod": {
      "username": "deploy",
      "auth": { "type": "key", "privateKey": "C:/Users/you/.ssh/id_ed25519" },
      "parallel": true,
      "remote": { "stopCommand": "systemctl stop app", "startCommand": "systemctl start app" },
      "services": [
        {
          "name": "app",
          "build": { "command": "mvn package -DskipTests" },
          "artifacts": [{ "local": "target/app.jar", "remote": "app.jar" }],
          "remote": { "healthCheck": { "type": "http", "url": "http://127.0.0.1:8080/health" } },
          "instances": [
            { "host": "10.0.0.1", "remote": { "deployDir": "/opt/app" } },
            { "host": "10.0.0.2", "remote": { "deployDir": "/opt/app" } },
            { "host": "10.0.0.3", "remote": { "deployDir": "/opt/app" } }
          ]
        }
      ]
    }
  }
}
```

构建与产物只准备一份，逐台（或 `parallel` 并发）上传部署；`deploy_remote` 用 `instance`（host 或序号）可以只操作某一台。

## 结合项目使用

- `.dsh-deploy.json` 放在**项目根目录**，插件按当前工作区（= 项目）自动读取对应环境；环境名自由（test/uat/prod/任意）。
- **务必把 `.dsh-deploy.json` 加入 `.gitignore`**——里面是明文服务器密码/密钥路径；建议提交一份 `*.example.json` 模板给团队（仓库 `examples/` 下有单机与微服务两份）。
- 每个开发者/机器各自配置自己的文件；服务器信息不进 npm 包。
- 部署日志与每条远程命令都投影在侧边栏终端，失败时直接在那里看输出。

## 安全提示

- 密码当前以明文存于项目目录的 `.dsh-deploy.json` 中——只放自己能控制的项目与环境、严格 gitignore。
- 优先使用 SSH 密钥认证（`auth.type = "key"`）。
- 插件只通过 SSH 操作目标机，不改动本地其他文件。

## 发布新版（维护者）

```powershell
# 改 package.json 的 version 后
npm login --registry https://registry.npmjs.org/
npm publish --registry https://registry.npmjs.org/
```

用户升级：`dsh plugin --profile web add dsh-server-deploy@latest`，然后重启 dsh web。
