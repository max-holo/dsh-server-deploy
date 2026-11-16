// dsh-deploy host plugin (npm bundle node half): global server deployment
// tools + an in-memory per-session run store served at /api/dsh-deploy/status.
// Remote command execution is projected onto a real sidebar terminal (via the
// terminalController service) by teeing every command into a local log that the
// terminal follows. The SSH/SFTP pipeline runs in-process on ssh2 + adm-zip
// (see engine.cjs) — no Python/paramiko needed on the machine.
'use strict'

const { opDeploy, opRemote, opDeployMany, resolveServiceEnv } = require('./engine.cjs')
const fsNode = require('node:fs')
const osNode = require('node:os')
const pathNode = require('node:path')

const CONFIG_FILE = '.dsh-deploy.json'
const MAX_SESSIONS = 50
const MAX_HISTORY = 5

const DEPLOY_PROMPT = [
  '## 应用部署工具 (dsh-deploy plugin)',
  '当用户要求把本地项目部署到服务器（“部署”“发版”“部署到 test/uat/prod”等，任意环境）时，使用以下工具：',
  '- `deploy_config`：管理当前项目工作区下的 .dsh-deploy.json（项目 → 目标服务器映射：服务器账号/密码、部署目录、备份目录、启停命令、前端解压、健康检查）。action: init（可选 template: single/frontend/services/cluster 生成对应形态的模板）/add/update/remove/list。',
  '- `deploy_run`：执行完整部署（可选本地构建 → 上传 → 远程备份 → 停止服务 → 替换文件/解压前端 → 启动服务 → 健康检查），远程命令执行过程实时投影到侧边栏终端。支持四种部署形态：单机（backend/raw）、前端（frontend，本地目录打 zip 上传解压）、微服务（`services` 数组，每个服务可部署到不同服务器，一次调用全部部署或用 `services` 参数只部署子集）、集群（服务配 `instances` 数组，同一服务部署到多台机器，`parallel: true` 并发）。',
  '- `deploy_remote`：快速远程操作 status/stop/start/restart/backup/restore/clean-backups/cmd，不部署；同样把命令输出投影到侧边栏终端；多服务/集群环境可用 `service`/`instance` 参数指定服务实例（其服务器/命令）。',
  '启停方式：服务器上有控制脚本（.sh）时用脚本，没有时回退到 stopCommand/startCommand（systemctl 等）；若环境配置了 `remote.scripts.autoGenerate`，缺失的脚本会由插件自动生成（java jar 模板：nohup 启动 + pid 管理）。',
  '性能：多服务/多实例环境设 `parallel: true`（可选 `concurrency: N`，默认 4）即可并发部署，总耗时≈最慢的那个；备份默认不压缩 tar（要压缩才设 `remote.backupCompress: true`）以省掉 gzip 这个最慢的环节，并自动排除 logs 等运行时目录；上传走 SFTP 分片并发（`remote.uploadConcurrency`/`uploadChunkSize` 可调）。',
  '自动识别：当前工作区就是项目本身，工具自动读取其 .dsh-deploy.json 并找到对应目标服务器。若配置不存在，先向用户询问一次服务器信息（以及部署形态：单机/前端/微服务/集群），再用 deploy_config init（带 template）写入。',
  '缺配置时必须问，不要猜：配置存在但缺字段时，deploy_run/deploy_config 会以“xxx is required / needs xxx”点名缺失项——把缺失项转述给用户询问（如部署目录、启停命令、产物路径），拿到答案后用 deploy_config update 补齐再重试；绝不编造服务器地址、路径或命令。',
  '安全：绝不在聊天中回显密码（deploy_config list 自动打码）；建议把 .dsh-deploy.json 加入 .gitignore。',
  '认证（所有形态通用）：`auth.type = "key"`（推荐，`privateKey` 支持 ~ 路径与 passphrase，不填时自动找 ~/.ssh/id_ed25519 → id_ecdsa → id_rsa，都没有则用 SSH agent）或 `auth.type = "password"`；微服务/集群的 auth 可配在父级共享，也可在每个 service / instance 上单独覆盖。向用户推荐密钥认证。',
].join('\n')

function tail(text, n) {
  const t = String(text || '').trim()
  if (t.length <= n) return t
  return t.slice(0, Math.floor(n / 2)) + '\n...[truncated]...\n' + t.slice(-Math.floor(n / 2))
}

function isAbsolutePath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p)
}

function joinPath(base, rel) {
  const sep = base.includes('\\') ? '\\' : '/'
  const cleanRel = String(rel || '').replace(/[\\/]+$/, '')
  return cleanRel.length === 0 ? base : base.replace(/[\\/]+$/, '') + sep + cleanRel
}

/** Shell command that follows a growing local log file, printed to the sidebar terminal. */
function followCommandFor(shellName, logPath) {
  const p = String(logPath).replace(/'/g, "''")
  const name = String(shellName || '').toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop()
  if (name === 'pwsh' || name === 'powershell') {
    // Clear-Host wipes the prompt, command echo, and the PSReadLine history write
    // warning (sandbox denies AppData write) so the first visible line is the log.
    return `Clear-Host; Get-Content -LiteralPath '${p}' -Wait`
  }
  if (name === 'cmd' || name === 'command prompt') {
    // cmd has no live-follow; delegate to the always-present Windows PowerShell.
    return `cls & powershell -NoLogo -NoProfile -Command "Get-Content -LiteralPath '${p}' -Wait"`
  }
  return `clear; tail -n +1 -f "${p}"`
}

/** The "Enter" byte for a terminal is CR, matching the harness's own PTY submit (terminal-bash). */
const TERMINAL_ENTER = '\r'

/** Chinese step labels for the terminal projection (process-oriented view). */
const STEP_LABELS_ZH = {
  build: '构建',
  connect: '连接服务器',
  upload: '上传产物',
  backup: '备份',
  stop: '停止服务',
  deploy: '部署',
  start: '启动服务',
  healthCheck: '健康检查',
  preCommands: '前置命令',
  postCommands: '后置命令',
  status: '服务状态',
  restart: '重启服务',
  restore: '回滚',
  'clean-backups': '清理备份',
  cmd: '执行命令',
}

function deepMerge(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}))
  const p = patch || {}
  for (const key of Object.keys(p)) {
    const v = p[key]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
      && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], v)
    } else {
      out[key] = v
    }
  }
  return out
}

function maskEnv(env) {
  const copy = JSON.parse(JSON.stringify(env || {}))
  const auth = copy.auth
  if (auth && auth.type !== 'key' && typeof auth.password === 'string' && auth.password.length > 0) {
    auth.password = '******'
  }
  return copy
}

function cleanJson(value) {
  if (Array.isArray(value)) return value.map(cleanJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      const v = cleanJson(value[k])
      if (v !== undefined) out[k] = v
    }
    return out
  }
  return value
}

/**
 * init 模板：按部署形态生成 .dsh-deploy.json 的首个环境。
 * - single   单机后端：一个 jar/war + systemctl，最常见的形态
 * - frontend 前端：本地目录（dist）打 zip → 上传 → 解压到 nginx 目录，无启停
 * - services 微服务：services 数组，每个服务可独立构建/服务器/健康检查，parallel 并发
 * - cluster  集群：同一服务 instances 多台机器（其余配置一份，逐台部署）
 */
function templateConfig(projectName, template) {
  const t = template || 'single'
  const base = {
    project: projectName,
    environments: {},
  }
  if (t === 'frontend') {
    base.environments.test = {
      host: '192.168.0.10',
      port: 22,
      username: 'root',
      auth: { type: 'key', privateKey: '~/.ssh/id_ed25519' }, // 推荐密钥；无密钥改 { type: 'password', password: '...' }
      sudo: false,
      type: 'frontend',
      build: { command: 'npm run build', cwd: '' },
      package: { local: 'dist', remoteName: 'frontend.zip' },
      remote: {
        deployDir: '/usr/share/nginx/html/app',
        stagingDir: '/tmp/dsh-deploy',
        backupDir: '/opt/app-backups',
        backupMode: 'tar',
        backupCompress: false,
        backupKeep: 10,
        preCommands: [],
        // 前端是静态文件，无启停
        stopCommand: '',
        startCommand: '',
        statusCommand: '',
        postCommands: [],
        // true = 解压前清空 deployDir（纯静态站推荐）；有上传目录等要保留的文件时改 false
        clean: false,
        unzipTool: 'auto',
        healthCheck: {
          type: 'http',
          url: 'http://127.0.0.1/index.html',
          expectedStatus: '200',
          retries: 6,
          intervalSec: 3,
          timeoutSec: 5,
        },
      },
    }
    return base
  }
  if (t === 'services') {
    base.environments.test = {
      // 父级只放共享默认；每个服务至少要有 name + 自己的 host（或继承父级 host）
      username: 'root',
      auth: { type: 'key', privateKey: '~/.ssh/id_ed25519' }, // 推荐密钥；无密钥改 { type: 'password', password: '...' }
      sudo: false,
      parallel: true,
      concurrency: 4,
      continueOnError: false,
      remote: {
        stagingDir: '/tmp/dsh-deploy',
        backupMode: 'tar',
        backupCompress: false,
        backupKeep: 10,
        backupExclude: ['logs', '*.log', 'nohup.out', 'tmp', 'cache', '*.pid'],
        // {{service}} 占位符会替换成服务名
        stopCommand: 'systemctl stop {{service}}',
        startCommand: 'systemctl start {{service}}',
        statusCommand: 'systemctl is-active {{service}}',
      },
      services: [
        {
          name: 'api',
          host: '192.168.0.11',
          build: { command: 'mvn clean package -DskipTests', cwd: '' },
          artifacts: [{ local: 'target/api.jar', remote: 'api.jar' }],
          remote: {
            deployDir: '/opt/api',
            backupDir: '/opt/backups/api',
            healthCheck: { type: 'http', url: 'http://127.0.0.1:8080/actuator/health', expectedStatus: '200', retries: 12, intervalSec: 5, timeoutSec: 5 },
          },
        },
        {
          name: 'web',
          host: '192.168.0.12',
          type: 'frontend',
          build: { command: 'npm run build', cwd: 'web' },
          package: { local: 'web/dist', remoteName: 'web.zip' },
          remote: {
            deployDir: '/usr/share/nginx/html/web',
            backupDir: '/opt/backups/web',
            stopCommand: '',
            startCommand: '',
            clean: false,
            healthCheck: { type: 'http', url: 'http://127.0.0.1/web/index.html', expectedStatus: '200', retries: 6, intervalSec: 3, timeoutSec: 5 },
          },
        },
      ],
    }
    return base
  }
  if (t === 'cluster') {
    base.environments.test = {
      username: 'root',
      auth: { type: 'key', privateKey: '~/.ssh/id_ed25519' }, // 推荐密钥；无密钥改 { type: 'password', password: '...' }
      sudo: false,
      parallel: true,
      remote: {
        stagingDir: '/tmp/dsh-deploy',
        backupMode: 'tar',
        backupCompress: false,
        backupKeep: 10,
        backupExclude: ['logs', '*.log', 'nohup.out', 'tmp', 'cache', '*.pid'],
        stopCommand: 'systemctl stop app',
        startCommand: 'systemctl start app',
        statusCommand: 'systemctl is-active app',
      },
      services: [
        {
          // 同一服务 × N 台机器：instances 各自带 host，其余配置共享一份
          name: 'app',
          build: { command: 'mvn clean package -DskipTests', cwd: '' },
          artifacts: [{ local: 'target/app.jar', remote: 'app.jar' }],
          remote: {
            healthCheck: { type: 'http', url: 'http://127.0.0.1:8080/health', expectedStatus: '200', retries: 12, intervalSec: 5, timeoutSec: 5 },
          },
          instances: [
            { host: '192.168.0.21', remote: { deployDir: '/opt/app', backupDir: '/opt/backups/app' } },
            { host: '192.168.0.22', remote: { deployDir: '/opt/app', backupDir: '/opt/backups/app' } },
            { host: '192.168.0.23', remote: { deployDir: '/opt/app', backupDir: '/opt/backups/app' } },
          ],
        },
      ],
    }
    return base
  }
  // default: single —— 单机后端
  base.environments.test = {
    host: '192.168.0.10',
    port: 22,
    username: 'root',
    auth: { type: 'key', privateKey: '~/.ssh/id_ed25519' }, // 推荐密钥；无密钥改 { type: 'password', password: '...' }
    sudo: false,
    type: 'backend',
    build: { command: '', cwd: '' },
    artifacts: [{ local: 'target/app.jar', remote: 'app.jar' }],
    remote: {
      deployDir: '/opt/app',
      stagingDir: '/tmp/dsh-deploy',
      backupDir: '/opt/app-backups',
      backupMode: 'tar',
      backupCompress: false,
      backupKeep: 10,
      preCommands: [],
      stopCommand: 'systemctl stop app',
      startCommand: 'systemctl start app',
      statusCommand: 'systemctl is-active app',
      postCommands: [],
      healthCheck: {
        type: 'http',
        url: 'http://127.0.0.1:8080/health',
        expectedStatus: '200',
        retries: 12,
        intervalSec: 5,
        timeoutSec: 5,
      },
    },
  }
  return base
}

/** init 模板说明：返回给模型的下一步指引。 */
const TEMPLATE_HINTS = {
  single: '单机后端模板：填 host/auth、build.command、artifacts 与 remote（启停/健康检查），然后 deploy_run。',
  frontend: '前端模板：build.command 构建后把 package.local 目录打成 zip 上传解压到 remote.deployDir（nginx 静态目录）；纯静态站建议 remote.clean=true；无启停命令。填好后 deploy_run。',
  services: '微服务模板：services 数组每个服务独立 host/构建/产物/健康检查，父级放共享默认（{{service}} 占位符替换服务名）；parallel=true 并发部署。替换成真实服务后 deploy_run。',
  cluster: '集群模板：同一服务 instances 多台机器，构建/产物/健康检查共享一份，每台只需 host + remote.deployDir；parallel=true 并发。填真实机器后 deploy_run。',
}

function validateScripts(remote) {
  const s = remote === null || typeof remote !== 'object' ? undefined : remote.scripts
  if (s !== undefined && s !== null) {
    if (typeof s !== 'object' || Array.isArray(s)) throw new Error('remote.scripts must be an object')
    for (const k of ['dir', 'start', 'stop', 'restart', 'status']) {
      if (s[k] !== undefined && typeof s[k] !== 'string') throw new Error(`remote.scripts.${k} must be a string`)
    }
    if (s.autoGenerate !== undefined && s.autoGenerate !== null) {
      if (typeof s.autoGenerate !== 'object' || Array.isArray(s.autoGenerate)) throw new Error('remote.scripts.autoGenerate must be an object')
      for (const k of ['jar', 'javaOpts', 'logFile', 'pidFile']) {
        if (s.autoGenerate[k] !== undefined && typeof s.autoGenerate[k] !== 'string') throw new Error(`remote.scripts.autoGenerate.${k} must be a string`)
      }
    }
  }
  if (remote === null || typeof remote !== 'object') return
  if (remote.backupCompress !== undefined && typeof remote.backupCompress !== 'boolean') {
    throw new Error('remote.backupCompress must be a boolean')
  }
  for (const k of ['uploadConcurrency', 'uploadChunkSize']) {
    if (remote[k] !== undefined && (!Number.isFinite(Number(remote[k])) || Number(remote[k]) < 1)) {
      throw new Error(`remote.${k} must be a positive number`)
    }
  }
}

function validateEnv(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('environment must be an object')
  }
  if (env.parallel !== undefined && typeof env.parallel !== 'boolean') throw new Error('environment.parallel must be a boolean')
  if (env.concurrency !== undefined && (!Number.isFinite(Number(env.concurrency)) || Number(env.concurrency) < 1)) {
    throw new Error('environment.concurrency must be a positive number')
  }
  // ---- microservices mode: a `services` array beats the single-service shape ----
  if (Array.isArray(env.services) && env.services.length > 0) {
    if (typeof env.host !== 'string' || env.host.trim() === '') {
      // the parent env may omit the host when every service names its own
      const missing = env.services.some(svc => !svc || typeof svc.host !== 'string' || svc.host.trim() === '')
      if (missing) throw new Error('services environment needs environment.host or a host on every service')
    }
    for (const svc of env.services) {
      if (svc === null || typeof svc !== 'object') throw new Error('each service must be an object')
      if (typeof svc.name !== 'string' || svc.name.trim() === '') throw new Error('each service needs a name')
      const instances = Array.isArray(svc.instances) ? svc.instances : null
      if (instances !== null) {
        if (instances.length === 0) throw new Error(`service "${svc.name}" has an empty instances array`)
        for (const inst of instances) {
          if (inst === null || typeof inst !== 'object') throw new Error(`service "${svc.name}": each instance must be an object`)
          if ((typeof inst.host !== 'string' || inst.host.trim() === '') && (typeof svc.host !== 'string' || svc.host.trim() === '')) {
            throw new Error(`service "${svc.name}": instance needs a host (its own or the service-level host)`)
          }
          const resolved = resolveServiceEnv(env, svc, inst)
          if (typeof (resolved.remote || {}).deployDir !== 'string' || (resolved.remote || {}).deployDir.trim() === '') {
            throw new Error(`service "${svc.name}" instance ${inst.host || ''} needs remote.deployDir (its own, service-level, or inherited)`)
          }
          validateScripts(resolved.remote)
        }
      } else {
        const resolved = resolveServiceEnv(env, svc)
        if (typeof (resolved.remote || {}).deployDir !== 'string' || (resolved.remote || {}).deployDir.trim() === '') {
          throw new Error(`service "${svc.name}" needs remote.deployDir (its own or inherited)`)
        }
        validateScripts(resolved.remote)
        if (resolved.type === 'frontend') {
          if (typeof (resolved.package || {}).local !== 'string' || (resolved.package || {}).local.trim() === '') {
            throw new Error(`service "${svc.name}" (frontend) needs package.local`)
          }
        } else if (!Array.isArray(resolved.artifacts) || resolved.artifacts.length === 0) {
          throw new Error(`service "${svc.name}" needs at least one artifact (its own or inherited)`)
        }
      }
    }
    env.type = 'services'
    env.remote = env.remote || {}
    env.remote.stagingDir = env.remote.stagingDir || '/tmp/dsh-deploy'
    env.remote.backupKeep = env.remote.backupKeep || 10
    return env
  }
  if (typeof env.host !== 'string' || env.host.trim() === '') throw new Error('environment.host is required')
  env.port = env.port || 22
  env.username = env.username || 'root'
  if (env.auth === undefined || env.auth === null) env.auth = { type: 'key' } // 默认密钥：自动找 ~/.ssh/id_ed25519 → id_ecdsa → id_rsa → SSH agent
  if (env.auth.type === undefined) env.auth.type = env.auth.password !== undefined ? 'password' : 'key'
  if (env.auth.type === 'password' && typeof env.auth.password !== 'string') env.auth.password = ''
  env.type = env.type || 'backend'
  env.remote = env.remote || {}
  if (typeof env.remote.deployDir !== 'string' || env.remote.deployDir.trim() === '') {
    throw new Error('environment.remote.deployDir is required')
  }
  env.remote.stagingDir = env.remote.stagingDir || '/tmp/dsh-deploy'
  env.remote.backupKeep = env.remote.backupKeep || 10
  validateScripts(env.remote)
  if (env.type === 'frontend') {
    env.package = env.package || {}
    if (typeof env.package.local !== 'string' || env.package.local.trim() === '') {
      throw new Error('frontend environment needs package.local (directory to zip)')
    }
  } else if (env.type === 'backend' || env.type === 'raw') {
    if (!Array.isArray(env.artifacts) || env.artifacts.length === 0) {
      throw new Error('environment.artifacts needs at least one { local, remote } entry')
    }
  } else {
    throw new Error('environment.type must be backend | frontend | raw')
  }
  return env
}

function pickEnv(config, environment) {
  const envs = config.environments || {}
  if (typeof environment === 'string' && environment.trim() !== '') {
    const found = envs[environment]
    if (found === undefined) {
      throw new Error('environment "' + environment + '" not found; available: ' + Object.keys(envs).join(', '))
    }
    return { key: environment, env: found }
  }
  const keys = Object.keys(envs)
  if (keys.length === 0) throw new Error('no environments configured')
  if (keys.length === 1) return { key: keys[0], env: envs[keys[0]] }
  throw new Error('multiple environments configured; choose one of: ' + keys.join(', '))
}

module.exports = {
  name: 'dsh-server-deploy',
  inject: ['tools', 'systemPrompt', 'fs', 'shell', 'sandboxPolicy', 'webServer'],
  apply(ctx) {
    const shell = ctx.get('shell')
    const fs = ctx.get('fs')
    if (shell === undefined || fs === undefined) return

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({ name: 'tool:dsh-deploy', order: 3100, text: DEPLOY_PROMPT }))
    }

    const sandboxPolicy = ctx.get('sandboxPolicy')
    const webServer = ctx.get('webServer')
    const terminalController = ctx.get('terminalController')

    // ---- diagnostics (terminal projection lifecycle) ------------------------
    function diag(text) {
      try {
        fsNode.appendFileSync(pathNode.join(__dirname, 'dsh-deploy-diag.log'), new Date().toISOString() + ' ' + text + '\n')
      } catch (ignored) { /* never break the pipeline */ }
    }
    diag('plugin apply: terminalController=' + (terminalController === undefined ? 'undefined' : 'present'))

    // ---- per-session run store (bounded, no secrets) -----------------------
    const sessions = new Map() // sessionId -> { current, history: [], append, terminalId }

    function sessionKey(exec) {
      try {
        if (exec.agent !== undefined && exec.agent.session !== undefined) return String(exec.agent.session.id)
      } catch (err) {
        // fall through
      }
      try {
        if (exec.agent !== undefined) return String(exec.agent.id)
      } catch (err) {
        // fall through
      }
      return 'unknown'
    }

    function storeFor(sessionId) {
      let entry = sessions.get(sessionId)
      if (entry === undefined) {
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value
          sessions.delete(oldest)
        }
        entry = { current: null, history: [], append: null, terminalId: null, sessionId, logPath: null, lastTail: '', agentTerminal: null }
        sessions.set(sessionId, entry)
      }
      return entry
    }

    function beginRun(sessionId, label, environment, host, kind) {
      const entry = storeFor(sessionId)
      // Bumped per run so the browser half knows when to retype the follow
      // command into the reused deploy terminal.
      entry.seq = (typeof entry.seq === 'number' ? entry.seq : 0) + 1
      entry.current = {
        runId: 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36),
        kind,
        label,
        environment,
        host,
        startedAt: Date.now(),
        finishedAt: null,
        ok: null,
        error: null,
        steps: [],
      }
      return entry.current
    }

    function addStep(run, step) {
      if (run === null) return
      const record = {
        step: step.step || 'step',
        status: step.status || 'running',
        detail: typeof step.detail === 'string' ? step.detail : undefined,
        durationMs: step.durationMs,
        at: Date.now(),
      }
      if (typeof step.service === 'string' && step.service.length > 0) record.service = step.service
      run.steps.push(record)
    }

    /** Read the newest `maxChars` of the run log; the deploy terminal renders the same file. */
    function readLogTail(logPath, maxChars) {
      try {
        if (typeof logPath !== 'string' || logPath.length === 0) return ''
        const size = fsNode.statSync(logPath).size
        if (size <= 0) return ''
        const bytes = Math.min(size, Math.max(8192, maxChars * 4))
        const buf = Buffer.alloc(bytes)
        const fd = fsNode.openSync(logPath, 'r')
        try { fsNode.readSync(fd, buf, 0, bytes, size - bytes) } finally { fsNode.closeSync(fd) }
        let text = buf.toString('utf8').replace(/^\uFEFF/, '')
        if (bytes < size) {
          const cut = text.indexOf('\n')
          if (cut >= 0) text = text.slice(cut + 1)
        }
        return text.length > maxChars ? text.slice(text.length - maxChars) : text
      } catch (err) {
        return ''
      }
    }

    function finishRun(entry, ok, error) {
      if (entry.current === null) return
      // The tool result carries the tail the user is watching, so the model can
      // judge a failure without a second round trip into the terminal.
      entry.lastTail = readLogTail(entry.logPath, 2000)
      entry.current.ok = ok
      entry.current.error = error === undefined ? null : String(error)
      entry.current.finishedAt = Date.now()
      if (typeof entry.append === 'function') {
        try {
          const took = Math.round((entry.current.finishedAt - entry.current.startedAt) / 1000)
          const verdict = ok ? '✔ 完成' : '✘ 失败'
          entry.append('\n' + '─'.repeat(48) + '\n' + verdict + (took > 0 ? ' · ' + took + 's' : '') + (error == null ? '' : '\n' + String(error)) + '\n')
        } catch (ignored) { /* terminal banner must never break the run */ }
      }
      entry.history.unshift(entry.current)
      if (entry.history.length > MAX_HISTORY) entry.history.pop()
      entry.current = null
      if (typeof entry.sessionId === 'string') broadcastStatus(entry.sessionId)
    }

    // ---- sidebar-terminal projection ---------------------------------------
    // Creates a real sidebar terminal, points it at a local log file (tail -f /
    // Get-Content -Wait), and returns an `append` that the engine tees every
    // remote command into. Closes the previous deploy terminal for the session.
    //
    // `terminalController` is session-scoped (its `inject` includes session
    // execution providers), so it is resolved from the running Agent's context
    // rather than the bundle's root context.
    function resolveTerminal(exec) {
      const scopes = []
      try { if (exec && exec.agent) scopes.push(['agent.ctx', exec.agent.ctx]) } catch (ignored) { /* noop */ }
      try { if (exec && exec.agent && exec.agent.scope) scopes.push(['agent.scope.ctx', exec.agent.scope.ctx]) } catch (ignored) { /* noop */ }
      scopes.push(['root.ctx', ctx])
      for (const [via, c] of scopes) {
        try {
          if (c !== undefined && c !== null && typeof c.get === 'function') {
            const tc = c.get('terminalController')
            if (tc !== undefined) return { tc, via }
          }
        } catch (ignored) { /* fall through */ }
      }
      return { tc: undefined, via: 'none' }
    }

    /** Pick a PowerShell shell (prefer pwsh 7, then Windows PowerShell 5.1) from the discovered shells. */
    async function pickPowerShellPath(terminalController, exec) {
      try {
        const shells = await terminalController.shells(exec.agent, exec.signal)
        const norm = (s) => String(s && s.name ? s.name : '').toLowerCase().replace(/\.exe$/, '')
        const chosen = shells.find(s => norm(s) === 'pwsh') || shells.find(s => norm(s) === 'powershell')
        return chosen ? { path: chosen.path, name: chosen.name } : undefined
      } catch (ignored) {
        return undefined
      }
    }

    /**
     * Open (or reuse) an Agent terminal for the deploy log.
     *
     * DSH 0.2.2 added `openForAgent`: the Host types input itself, the sidebar
     * terminal provider opens the tab, the shell runs inside the session's
     * sandbox, and the model can read the screen with `readScreen`. That
     * replaces the older "browser attaches and types the follow command" dance.
     * Returns null when the host does not offer it (older DSH) or the attempt
     * fails, so the caller can fall back to the legacy user terminal.
     */
    async function openAgentTerminal(terminalController, exec, entry, logPath, label) {
      if (typeof terminalController.openForAgent !== 'function') return null
      const policy = policyFor(exec)
      if (policy === null || policy === undefined || typeof policy.mode !== 'string') {
        diag('agent terminal skipped: no sandbox policy for this session')
        return null
      }
      const preferredShells = process.platform === 'win32' ? ['pwsh', 'powershell'] : []
      let term = entry.agentTerminal
      try {
        const live = term === null || term === undefined ? undefined : term.info
        const reusable = live !== undefined && live !== null && live.state === 'running' && live.control === 'agent'
        if (!reusable) {
          term = await terminalController.openForAgent(exec.agent, {
            title: '部署 · ' + String(label === undefined || label === null ? '' : label).slice(0, 60),
            cols: 140,
            rows: 40,
            policy,
            preferredShells,
          }, exec.signal)
          entry.agentTerminal = term
          diag('agent terminal created: ' + term.id)
        } else {
          diag('agent terminal reused: ' + term.id)
        }
        const shellName = term.info && term.info.shell !== null && term.info.shell !== undefined ? term.info.shell.name : ''
        const cmd = followCommandFor(shellName, logPath)
        // Ctrl-C drops whatever the previous run left running, then retype the follow command.
        try { await term.write('\u0003') } catch (interruptErr) { diag('agent terminal interrupt ignored: ' + String(interruptErr && interruptErr.message ? interruptErr.message : interruptErr)) }
        await term.write(cmd + '\r')
        return { terminalId: term.id, agentMode: true }
      } catch (err) {
        diag('agent terminal unavailable: ' + String(err && err.message ? err.message : err))
        return null
      }
    }

    async function openTerminal(exec, sessionId, runId, label) {
      const resolved = resolveTerminal(exec)
      if (resolved.tc === undefined) {
        diag('openTerminal skipped: terminalController not found (via=' + resolved.via + ')')
        return { terminalId: null, append: null, error: 'terminalController service is not available in this session' }
      }
      const terminalController = resolved.tc
      diag('openTerminal resolved via ' + resolved.via)
      try {
        const entry = storeFor(sessionId)
        const logPath = pathNode.join(osNode.tmpdir(), 'dsh-deploy-' + runId + '.log')
        // UTF-8 BOM so PowerShell's Get-Content auto-detects UTF-8 (else Chinese garbles on GBK code pages).
        fsNode.appendFileSync(logPath, '\ufeff' + 'dsh-deploy · ' + label + '\n' + '='.repeat(48) + '\n')
        entry.logPath = logPath
        entry.lastTail = ''
        const append = (text) => { try { fsNode.appendFileSync(logPath, text) } catch (ignored) { /* disk full etc. */ } }
        // Preferred path on DSH 0.2.2+: the Host owns the shell, types the follow
        // command, and the model can read the screen. Falls back to the legacy
        // user terminal below when the host or the session policy disallows it.
        const agentTerm = await openAgentTerminal(terminalController, exec, entry, logPath, label)
        if (agentTerm !== null) {
          entry.terminalId = agentTerm.terminalId
          entry.followCommand = null
          entry.append = append
          diag('openTerminal ready (agent terminal): ' + agentTerm.terminalId + ' logPath=' + logPath)
          return { terminalId: agentTerm.terminalId, append, followCommand: null, agentMode: true }
        }
        // One stable deploy terminal per Session: the sidebar merges page tabs of
        // the same kind (closing the arriving one and focusing the existing tab),
        // so a fresh id per run would leave the visible tab pointing at a closed
        // terminal ("此终端已不存在"). Reuse the running terminal instead and let
        // the browser retype the follow command for each run.
        const stableId = 'dsh-deploy-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')
        const ps = await pickPowerShellPath(terminalController, exec)
        let live = []
        try { live = typeof terminalController.list === 'function' ? terminalController.list(sessionId) : [] } catch (ignored) { live = [] }
        // Reuse the terminal this Session already used (it survives run to run);
        // if the user closed that tab the identity is closed for good, so walk
        // candidate ids until one can be created and then keep reusing THAT one.
        const candidates = []
        const previous = typeof entry.terminalId === 'string' && entry.terminalId.startsWith('dsh-deploy-') ? entry.terminalId : null
        if (previous !== null) candidates.push(previous)
        candidates.push(stableId)
        for (let i = 2; i <= 9; i++) candidates.push(stableId + '-' + i)
        let terminalId = null
        let info = undefined
        for (const candidate of candidates) {
          const found = live.find(t => t !== null && t !== undefined && t.id === candidate && t.state === 'running')
          if (found !== undefined) {
            terminalId = candidate
            info = found
            diag('openTerminal reusing: id=' + candidate + ' logPath=' + logPath)
            break
          }
          const request = { id: candidate, cols: 140, rows: 40 }
          if (ps !== undefined) request.shellPath = ps.path
          try {
            const created = await terminalController.create(exec.agent, request, exec.signal)
            if (created === undefined || created === null || created.state !== 'running') {
              diag('openTerminal candidate not running: ' + candidate + ' state=' + (created && created.state))
              continue
            }
            terminalId = candidate
            info = created
            diag('openTerminal created: id=' + candidate + ' shell=' + (created.shell && created.shell.name))
            break
          } catch (createErr) {
            diag('openTerminal candidate unavailable: ' + candidate + ' (' + String(createErr && createErr.message ? createErr.message : createErr) + ')')
          }
        }
        if (terminalId === null || info === undefined) throw new Error('no usable deploy terminal identity')
        // 0.2.1 removed host-side terminal input injection (follow/write/attachmentId).
        // The browser half attaches to the terminal stream and types the follow command;
        // this route exposes that command alongside the terminal id.
        const followCmd = followCommandFor(info && info.shell && info.shell.name, logPath)
        entry.terminalId = terminalId
        entry.followCommand = followCmd
        entry.append = append
        diag('openTerminal ready (client drives input): ' + terminalId + ' cmd=' + followCmd)
        return { terminalId, append, followCommand: followCmd }
      } catch (err) {
        diag('openTerminal FAILED: ' + String(err && err.stack ? err.stack : err))
        return { terminalId: null, append: null, error: String(err && err.message ? err.message : err) }
      }
    }

    // ---- event push (SSE) ---------------------------------------------------
    // The browser half listens on /api/dsh-deploy/events instead of polling
    // /status once a second. Events carry the same payload as the status route.
    const sseClients = new Map() // sessionId -> Set<http.ServerResponse>

    function statusPayload(sessionId) {
      const entry = sessionId === '' ? null : (sessions.get(sessionId) ?? null)
      const current = entry === null ? null : entry.current
      return {
        ok: true,
        session: sessionId,
        current,
        terminalId: (current !== null && typeof current.terminalId === 'string' ? current.terminalId : null)
          ?? (entry === null ? null : entry.terminalId),
        // Shell command the browser types into the created terminal to follow the
        // deploy log (host-side input injection no longer exists).
        followCommand: entry !== null && typeof entry.followCommand === 'string' ? entry.followCommand : null,
        // Run counter: the browser retypes followCommand when it changes.
        seq: entry !== null && typeof entry.seq === 'number' ? entry.seq : 0,
        history: entry === null ? [] : entry.history,
      }
    }

    function broadcastStatus(sessionId) {
      const clients = sseClients.get(sessionId)
      if (clients === undefined || clients.size === 0) return
      const frame = 'event: status\ndata: ' + JSON.stringify(statusPayload(sessionId)) + '\n\n'
      for (const res of [...clients]) {
        try {
          res.write(frame)
        } catch (ignored) {
          try { res.end() } catch (e) { /* already gone */ }
          clients.delete(res)
        }
      }
    }

    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/dsh-deploy/status',
        handler(req, res) {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = url.searchParams.get('session') ?? ''
            const body = JSON.stringify(statusPayload(sessionId))
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(body)
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
          }
        },
      }))
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/dsh-deploy/events',
        handler(req, res) {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = url.searchParams.get('session') ?? ''
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            })
            res.write('retry: 3000\n\n')
            res.write('event: status\ndata: ' + JSON.stringify(statusPayload(sessionId)) + '\n\n')
            let clients = sseClients.get(sessionId)
            if (clients === undefined) { clients = new Set(); sseClients.set(sessionId, clients) }
            clients.add(res)
            const heartbeat = setInterval(() => {
              try { res.write(': ping\n\n') } catch (ignored) { cleanup() }
            }, 20000)
            function cleanup() {
              clearInterval(heartbeat)
              const set = sseClients.get(sessionId)
              if (set !== undefined) {
                set.delete(res)
                if (set.size === 0) sseClients.delete(sessionId)
              }
              try { res.end() } catch (ignored) { /* already gone */ }
            }
            req.on('close', cleanup)
            req.on('error', cleanup)
          } catch (error) {
            try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end('{}') } catch (ignored) { /* already gone */ }
          }
        },
      }))
    }

    function sessionWorkspace(exec) {
      try {
        const cwd = exec.agent.session.header.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      } catch (err) {
        // fall through
      }
      return null
    }

    function policyFor(exec) {
      if (sandboxPolicy === undefined) return null
      try {
        if (exec.agent !== undefined && exec.agent.session !== undefined) {
          return sandboxPolicy.resolve({ session: exec.agent.session })
        }
      } catch (err) {
        // fall through
      }
      return null
    }

    async function resolveWorkspace(exec) {
      const fromAgent = sessionWorkspace(exec)
      if (fromAgent !== null) return fromAgent
      const policy = policyFor(exec)
      if (policy !== null && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) return policy.workspaceRoot
      const target = await fs.resolve('.')
      return fs.processPath(target)
    }

    async function readConfig(ws, configPath) {
      const rel = configPath || CONFIG_FILE
      const target = await fs.resolve(rel, { cwd: ws })
      const info = await fs.stat(target)
      if (info === undefined || info.type !== 'file') return null
      const text = await fs.readText(target)
      try {
        return JSON.parse(text)
      } catch (err) {
        throw new Error('config ' + rel + ' is not valid JSON: ' + err.message)
      }
    }

    async function writeConfig(ws, configPath, data, policy) {
      const rel = configPath || CONFIG_FILE
      const target = await fs.resolve(rel, { cwd: ws })
      await fs.writeText(target, JSON.stringify(data, null, 2) + '\n', undefined, undefined, policy ?? undefined)
      return fs.processPath(target)
    }

    // ---------- deploy_config ----------
    const deployConfigTool = {
      name: 'deploy_config',
      description:
        'Manage server deploy configuration for the CURRENT PROJECT (the session workspace) — any environment (test/uat/prod). '
        + 'Config file .dsh-deploy.json maps this project to its target servers: server host/account/password, '
        + 'deploy dir, backup dir, stop/start commands, frontend unzip settings, health checks. '
        + 'Deployment shapes: single (backend jar/war on one machine), frontend (zip a local dist and unzip on the server), '
        + 'services (microservices, one entry per service), cluster (one service replicated over several machines via instances). '
        + 'Passwords are stored in the config file but never echoed in chat. '
        + 'actions: init (create a template, pick its shape with `template`), add (insert one full environment), '
        + 'update (merge partial changes), remove (delete an environment), list (show current environments with masked passwords).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['init', 'add', 'update', 'remove', 'list'], description: 'What to do with the config.' },
          template: {
            type: 'string',
            enum: ['single', 'frontend', 'services', 'cluster'],
            description: 'Deployment shape for action=init: single = one backend on one machine (default); frontend = zip a local dist to a static dir; services = microservices (one entry per service); cluster = one service replicated over N machines (instances).',
          },
          environment: { type: 'string', description: 'Environment key (e.g. test, uat, prod). Required for add/update/remove.' },
          settings: { description: 'Environment object for add (full) or update (partial merge). See deploy_run for accepted fields.' },
          configPath: { type: 'string', description: 'Relative config file path; defaults to .dsh-deploy.json.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        const ws = await resolveWorkspace(exec)
        const policy = policyFor(exec)
        const configPath = args.configPath || CONFIG_FILE
        const action = args.action
        if (action === 'init') {
          const existing = await readConfig(ws, configPath)
          if (existing !== null) throw new Error('config already exists: ' + configPath)
          const template = args.template || 'single'
          if (TEMPLATE_HINTS[template] === undefined) {
            throw new Error('template must be one of: single, frontend, services, cluster')
          }
          const name = ws.split(/[\\/]/).filter(Boolean).pop() || 'project'
          const saved = await writeConfig(ws, configPath, templateConfig(name, template), policy)
          return cleanJson({
            ok: true, action, template, configPath: saved, project: name,
            environments: ['test'],
            next: TEMPLATE_HINTS[template],
          })
        }
        const config = await readConfig(ws, configPath)
        if (config === null) throw new Error('no deploy config at ' + configPath + ' in ' + ws + '; run deploy_config with action=init first')
        if (action === 'list') {
          const envs = {}
          for (const key of Object.keys(config.environments || {})) envs[key] = maskEnv(config.environments[key])
          return cleanJson({ ok: true, action, configPath, project: config.project, environments: envs })
        }
        const key = args.environment
        if (typeof key !== 'string' || key.trim() === '') throw new Error('action ' + action + ' requires environment key')
        if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('environment key must match [A-Za-z0-9_-]+')
        config.environments = config.environments || {}
        if (action === 'remove') {
          if (!Object.prototype.hasOwnProperty.call(config.environments, key)) throw new Error('environment not found: ' + key)
          delete config.environments[key]
        } else if (action === 'add') {
          if (Object.prototype.hasOwnProperty.call(config.environments, key)) throw new Error('environment "' + key + '" already exists; use action=update')
          if (args.settings === undefined || args.settings === null || typeof args.settings !== 'object') {
            throw new Error('action=add requires settings: the full environment object')
          }
          config.environments[key] = validateEnv(JSON.parse(JSON.stringify(args.settings)))
        } else {
          if (!Object.prototype.hasOwnProperty.call(config.environments, key)) throw new Error('environment not found: ' + key)
          if (args.settings === undefined || args.settings === null || typeof args.settings !== 'object') {
            throw new Error('action=update requires settings: partial environment object to merge')
          }
          config.environments[key] = validateEnv(deepMerge(config.environments[key], args.settings))
        }
        const saved = await writeConfig(ws, configPath, config, policy)
        return cleanJson({ ok: true, action, environment: key, configPath: saved, environments: Object.keys(config.environments) })
      },
    }
    ctx.effect(() => ctx.tools.register(deployConfigTool))

    // ---------- deploy_run ----------
    const deployRunTool = {
      name: 'deploy_run',
      description:
        'Deploy the current project to a configured server in one shot — any environment (test/uat/prod). '
        + 'Pipeline: optional local build (build.command runs in the workspace) → upload artifacts (backend files, '
        + 'or zip a frontend directory) → remote backup of the current deployDir → stop service → replace files / '
        + 'unzip frontend → start service → health check. '
        + 'Deployment shapes: single backend, frontend (static dist), microservices (a `services` array — one entry '
        + 'per service, each with its own server/build/health check; deploy all or a subset via the `services` param), '
        + 'and cluster (a service with an `instances` array replicates the same build over several machines). '
        + 'Remote command execution streams live into a sidebar terminal, alongside the in-chat tool result. '
        + 'For multi-service/cluster environments, set `parallel: true` (optional `concurrency: N`, default 4) to deploy independent services/instances concurrently — wall-clock becomes the slowest one instead of the sum. '
        + 'Tar backups are uncompressed by default (set `remote.backupCompress: true` for .tar.gz), which skips the slowest step on large deploy dirs. '
        + 'The environment comes from .dsh-deploy.json in the current workspace (the project folder), so just name the '
        + 'environment key; omit it when only one is configured. Report each step status back to the user in the chat language they used.',
      parameters: {
        type: 'object',
        properties: {
          environment: { type: 'string', description: 'Environment key from .dsh-deploy.json (e.g. test, uat, prod). Omit when only one environment exists.' },
          services: { type: 'array', items: { type: 'string' }, description: 'Optional service names to deploy (microservices mode); omit to deploy all services in declaration order.' },
          skipBuild: { type: 'boolean', description: 'Skip every service\'s local build.command (artifacts must already exist).' },
          noBackup: { type: 'boolean', description: 'Skip the remote backup step.' },
          skipHealthCheck: { type: 'boolean', description: 'Skip the post-start health check.' },
          configPath: { type: 'string', description: 'Relative config file path; defaults to .dsh-deploy.json.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 2400000,
      async execute(args, exec) {
        const startedAt = Date.now()
        const sessionId = sessionKey(exec)
        const ws = await resolveWorkspace(exec)
        const config = await readConfig(ws, args.configPath || CONFIG_FILE)
        if (config === null) throw new Error('no deploy config in ' + ws + '; run deploy_config with action=init first')
        const picked = pickEnv(config, args.environment)
        const env = validateEnv(JSON.parse(JSON.stringify(picked.env)))
        const policy = policyFor(exec)
        const entry = storeFor(sessionId)
        const servicesMode = env.type === 'services'
        const servicesCount = servicesMode ? env.services.length : 1
        const run = beginRun(sessionId, 'deploy ' + picked.key + (servicesMode ? ` (${servicesCount} services)` : ''), picked.key, servicesMode ? `${servicesCount} services` : env.host, 'deploy')
        const steps = []

        // Project the whole run onto a real sidebar terminal (see openTerminal).
        const term = await openTerminal(exec, sessionId, run.runId, run.label)
        const append = typeof term.append === 'function' ? term.append : null
        run.terminalId = term.terminalId
        if (term.error !== undefined) run.terminalError = term.error
        diag('deploy_run openTerminal: terminalId=' + term.terminalId + (term.error !== undefined ? ' error=' + term.error : ''))
        broadcastStatus(sessionId)
        const logStep = (ev) => {
          if (append === null || ev === undefined) return
          try {
            const label = STEP_LABELS_ZH[ev.step] || String(ev.step)
            const svc = typeof ev.service === 'string' && ev.service.length > 0 ? '[' + ev.service + '] ' : ''
            if (ev.status === 'running') {
              append('\n' + '━'.repeat(3) + ' ' + svc + label + ' ' + '━'.repeat(3) + '\n')
            } else if (ev.status === 'skipped') {
              append('（跳过）' + (ev.detail ? ' ' + ev.detail : '') + '\n')
            } else if (ev.status === 'failed') {
              append('✘ ' + (ev.detail || '失败') + '\n')
            } else if (ev.detail) {
              append(ev.detail + '\n')
            }
          } catch (ignored) { /* never break the pipeline */ }
        }

        // local build for one resolved env (single-service or one member of a services env)
        async function runBuild(resolvedEnv) {
          if (!resolvedEnv.build || typeof resolvedEnv.build.command !== 'string' || resolvedEnv.build.command.trim() === '' || args.skipBuild) {
            return { ok: true, detail: 'no build configured', durationMs: 0 }
          }
          const t0 = Date.now()
          const buildDir = resolvedEnv.build.cwd ? joinPath(ws, resolvedEnv.build.cwd) : ws
          const spec = shell.resolve({
            command: resolvedEnv.build.command,
            workdir: buildDir,
            timeoutMs: 1800000,
            stdoutMaxBytes: 1048576,
            signal: exec.signal,
            sandboxPolicy: policy ?? undefined,
          })
          const execution = await shell.execute(spec)
          const res = await execution.result()
          if (append !== null) {
            try {
              append('$ ' + resolvedEnv.build.command + '\n' + tail(res.stdout.text, 4000) + (res.stderr.text ? '\n' + tail(res.stderr.text, 2000) : '') + '\n')
            } catch (ignored) { /* ignore */ }
          }
          let buildError = null
          if (res.exitCode !== 0) {
            if (res.timedOut) buildError = 'local build timed out after ' + res.timeoutMs + 'ms'
            else if (res.aborted) buildError = 'local build aborted'
            else if (res.exitCode === null) buildError = 'local build killed by signal ' + (res.signal || 'unknown')
            else buildError = 'local build failed (exitCode=' + res.exitCode + ')'
            if (res.stderr.text) buildError += '\n' + tail(res.stderr.text, 800)
          }
          return {
            ok: res.exitCode === 0,
            detail: tail(res.stdout.text, 1200),
            durationMs: Date.now() - t0,
            error: buildError,
          }
        }

        // resolve local artifact paths relative to the workspace on a resolved env
        function resolvePaths(resolvedEnv) {
          if (resolvedEnv.type === 'frontend') {
            if (!isAbsolutePath(resolvedEnv.package.local)) resolvedEnv.package.local = joinPath(ws, resolvedEnv.package.local)
          } else {
            for (const art of resolvedEnv.artifacts || []) {
              if (!isAbsolutePath(art.local)) art.local = joinPath(ws, art.local)
            }
          }
        }

        try {
          if (servicesMode) {
            const job = {
              environment: env,
              services: Array.isArray(args.services) ? args.services.map(String) : undefined,
              noBackup: !!args.noBackup,
              skipHealthCheck: !!args.skipHealthCheck,
            }
            const result = await opDeployMany(job, {
              signal: exec.signal,
              onStep(ev) {
                addStep(run, ev)
                steps.push({ service: ev.service, step: ev.step, status: ev.status, detail: ev.detail, durationMs: ev.durationMs })
                logStep(ev)
              },
              log: append === null ? undefined : append,
              async buildService(svc, svcEnv) {
                resolvePaths(svcEnv)
                return runBuild(svcEnv)
              },
            })
            if (result.ok) {
              finishRun(entry, true, null)
              return cleanJson({
                ok: true, project: config.project, environment: picked.key, services: result.services, steps, totalMs: Date.now() - startedAt,
                outputTail: entry.lastTail,
              })
            }
            const failed = (result.services || []).filter(s => !s.ok).map(s => `${s.name}: ${s.error || 'failed'}`).join('; ')
            finishRun(entry, false, failed)
            return cleanJson({
              ok: false, project: config.project, environment: picked.key, services: result.services, steps, error: failed,
              outputTail: entry.lastTail,
            })
          }

          logStep({ step: 'build', status: 'running' })
          const build = await runBuild(env)
          const buildStep = { step: 'build', status: build.ok ? 'ok' : 'failed', detail: build.detail, durationMs: build.durationMs }
          addStep(run, buildStep)
          steps.push(buildStep)
          logStep(buildStep)
          if (!build.ok) {
            finishRun(entry, false, build.error || 'local build failed')
            return cleanJson({ ok: false, project: config.project, environment: picked.key, host: env.host, steps, error: build.error || 'local build failed' })
          }
          resolvePaths(env)
          const job = {
            environment: env,
            noBackup: !!args.noBackup,
            skipHealthCheck: !!args.skipHealthCheck,
          }
          const result = await opDeploy(job, {
            signal: exec.signal,
            onStep(ev) {
              addStep(run, ev)
              steps.push({ step: ev.step, status: ev.status, detail: ev.detail, durationMs: ev.durationMs })
              logStep(ev)
            },
            log: append === null ? undefined : append,
          })
          if (result.ok) {
            finishRun(entry, true, null)
            return cleanJson({
              ok: true, project: config.project, environment: picked.key, host: env.host,
              deployDir: (env.remote || {}).deployDir, steps, totalMs: Date.now() - startedAt,
              outputTail: entry.lastTail,
            })
          }
          const error = result.error || 'deploy failed'
          finishRun(entry, false, error)
          return cleanJson({
            ok: false, project: config.project, environment: picked.key, host: env.host, steps, error,
            outputTail: entry.lastTail,
          })
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          finishRun(entry, false, message)
          throw new Error(message)
        }
      },
    }
    ctx.effect(() => ctx.tools.register(deployRunTool))

    // ---------- deploy_remote ----------
    const deployRemoteTool = {
      name: 'deploy_remote',
      description:
        'Run a remote operation on a configured server WITHOUT deploying — any environment (test/uat/prod): '
        + 'status (run statusCommand), stop / start / restart (configured commands + health check on restart), '
        + 'backup (snapshot current deployDir), restore (roll deployDir back to the latest backup), or cmd (any remote shell command). '
        + 'For a services environment, pass `service` to target one service\'s server and commands; '
        + 'when that service has multiple `instances` (cluster), pass `instance` too (its host, or the 1-based index). '
        + 'Remote command execution streams live into a sidebar terminal. '
        + 'Uses the environment from .dsh-deploy.json in the current workspace.',
      parameters: {
        type: 'object',
        properties: {
          environment: { type: 'string', description: 'Environment key from .dsh-deploy.json (e.g. test). Omit when only one environment exists.' },
          service: { type: 'string', description: 'Service name within a services environment; targets that service\'s server/commands.' },
          instance: { type: 'string', description: 'Instance of a multi-instance service: its host string, or the 1-based index as a string (e.g. "1").' },
          action: { type: 'string', enum: ['status', 'stop', 'start', 'restart', 'backup', 'restore', 'clean-backups', 'cmd'], description: 'Remote operation to perform. clean-backups removes EVERY entry in the backup dir (old backups that included logs).' },
          command: { type: 'string', description: 'Remote shell command to run; only for action=cmd.' },
          timeoutSec: { type: 'number', description: 'Per-command timeout in seconds; default 120.' },
          skipHealthCheck: { type: 'boolean', description: 'Skip health check after restart.' },
          configPath: { type: 'string', description: 'Relative config file path; defaults to .dsh-deploy.json.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 900000,
      async execute(args, exec) {
        const sessionId = sessionKey(exec)
        const ws = await resolveWorkspace(exec)
        const config = await readConfig(ws, args.configPath || CONFIG_FILE)
        if (config === null) throw new Error('no deploy config in ' + ws + '; run deploy_config with action=init first')
        const picked = pickEnv(config, args.environment)
        const env = validateEnv(JSON.parse(JSON.stringify(picked.env)))
        let targetEnv = env
        let serviceName = null
        let instanceLabel = null
        if (typeof args.service === 'string' && args.service.trim() !== '') {
          if (env.type !== 'services' || !Array.isArray(env.services)) {
            throw new Error('environment ' + picked.key + ' has no services; the service parameter only applies to services environments')
          }
          const svc = env.services.find(s => s && String(s.name) === args.service)
          if (svc === undefined) {
            throw new Error('service "' + args.service + '" not found; available: ' + env.services.map(s => s && s.name).filter(Boolean).join(', '))
          }
          let inst = null
          if (Array.isArray(svc.instances) && svc.instances.length > 0) {
            if (typeof args.instance === 'string' && args.instance.trim() !== '') {
              const sel = args.instance.trim()
              if (/^[1-9][0-9]*$/.test(sel)) {
                inst = svc.instances[Number(sel) - 1]
                if (inst === undefined) throw new Error('instance index ' + sel + ' out of range (service "' + svc.name + '" has ' + svc.instances.length + ' instances)')
              } else {
                inst = svc.instances.find(i => i && String(i.host) === sel)
                if (inst === undefined) throw new Error('instance host "' + sel + '" not found on service "' + svc.name + '"; available hosts: ' + svc.instances.map(i => i && i.host).filter(Boolean).join(', '))
              }
              instanceLabel = String(inst.host !== undefined ? inst.host : (svc.host || ''))
            } else {
              throw new Error('service "' + svc.name + '" has multiple instances; pass `instance` (host or 1-based index): ' + svc.instances.map((i, idx) => (idx + 1) + '=' + (i && i.host || '')).join(', '))
            }
          }
          targetEnv = resolveServiceEnv(env, svc, inst)
          serviceName = String(svc.name)
        }
        const entry = storeFor(sessionId)
        const run = beginRun(sessionId, args.action + ' ' + picked.key + (serviceName !== null ? '/' + serviceName : '') + (instanceLabel !== null ? '@' + instanceLabel : ''), picked.key, targetEnv.host, 'remote')
        const term = await openTerminal(exec, sessionId, run.runId, run.label)
        const append = typeof term.append === 'function' ? term.append : null
        run.terminalId = term.terminalId
        if (term.error !== undefined) run.terminalError = term.error
        diag('deploy_remote openTerminal: terminalId=' + term.terminalId + (term.error !== undefined ? ' error=' + term.error : ''))
        broadcastStatus(sessionId)
        const job = {
          environment: targetEnv,
          action: args.action,
          command: args.command,
          timeoutSec: args.timeoutSec || 120,
          skipHealthCheck: !!args.skipHealthCheck,
        }
        if (append !== null) {
          try {
            const label = STEP_LABELS_ZH[args.action] || String(args.action)
            const svc = serviceName !== null ? '[' + serviceName + '] ' : ''
            append('\n' + '━'.repeat(3) + ' ' + svc + label + ' ' + '━'.repeat(3) + '\n')
          } catch (ignored) { /* never break the pipeline */ }
        }
        try {
          const result = await opRemote(job, { signal: exec.signal, log: append === null ? undefined : append })
          if (!result.ok) {
            const error = result.error || ('remote ' + args.action + ' failed')
            finishRun(entry, false, error)
            throw new Error(error)
          }
          addStep(run, {
            service: serviceName === null ? undefined : serviceName,
            step: args.action,
            status: 'ok',
            detail: typeof result.stdout === 'string' ? tail(result.stdout, 800) : undefined,
          })
          finishRun(entry, true, null)
          return cleanJson({
            ok: true, action: args.action, environment: picked.key, service: serviceName === null ? undefined : serviceName, host: targetEnv.host,
            stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
            parts: result.parts, healthCheck: result.healthCheck, backup: result.backup, restored: result.restored,
            outputTail: entry.lastTail,
          })
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          finishRun(entry, false, message)
          throw new Error(message)
        }
      },
    }
    ctx.effect(() => ctx.tools.register(deployRemoteTool))
  },
}
