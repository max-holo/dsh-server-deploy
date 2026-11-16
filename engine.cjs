// dsh-deploy SSH engine: the whole deployment pipeline on pure Node.
// Transport = ssh2 (SSH/SFTP), local frontend packaging = adm-zip. Both are
// ordinary npm dependencies installed automatically by `dsh plugin add`, so
// consumers need NO Python/paramiko on their machines.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Client } = require('ssh2')
const AdmZip = require('adm-zip')

function nowMs() {
  return Date.now()
}

function tailText(text, limit = 4000) {
  const t = String(text || '').trim()
  if (t.length <= limit) return t
  return t.slice(0, Math.floor(limit / 2)) + '\n...[truncated]...\n' + t.slice(-Math.floor(limit / 2))
}

function timestamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * First conventional private key file that exists, in modern-first order.
 * @returns absolute path, or null when none of id_ed25519 / id_ecdsa / id_rsa exists.
 */
function defaultPrivateKeyPath() {
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const candidate = path.join(os.homedir(), '.ssh', name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch (ignored) { /* not present; try the next */ }
  }
  return null
}

function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One SSH connection with exec + sftp helpers. */
class SshSession {
  constructor(env, signal, onExec) {
    this.env = env
    this.client = new Client()
    this.signal = signal
    this.connected = false
    this.closed = false
    this.sftpPromise = null
    this.sftpHandle = null
    this.onExec = typeof onExec === 'function' ? onExec : null
    // SFTP upload tuning: more concurrent chunks speed up high-latency links.
    const remoteCfg = env.remote || {}
    const uploadOptions = {}
    if (Number(remoteCfg.uploadConcurrency) > 0) uploadOptions.concurrency = Number(remoteCfg.uploadConcurrency)
    if (Number(remoteCfg.uploadChunkSize) > 0) uploadOptions.chunkSize = Number(remoteCfg.uploadChunkSize)
    this.uploadOptions = Object.keys(uploadOptions).length > 0 ? uploadOptions : { concurrency: 64, chunkSize: 262144 }
  }

  async connect() {
    const env = this.env
    const auth = env.auth || {}
    const opts = {
      host: env.host,
      port: env.port || 22,
      username: env.username || 'root',
      readyTimeout: (env.connectTimeout || 15) * 1000,
    }
    if (auth.type === 'key') {
      // Explicit path wins; otherwise try the conventional key files in order,
      // and fall back to the SSH agent (SSH_AUTH_SOCK) when none exists.
      const keyPath = auth.privateKey ? expandHome(auth.privateKey) : defaultPrivateKeyPath()
      if (keyPath !== null) {
        try {
          opts.privateKey = fs.readFileSync(keyPath)
        } catch (err) {
          throw new Error(`cannot load private key: ${keyPath} (${err.message})`)
        }
      } else if (process.env.SSH_AUTH_SOCK) {
        opts.agent = process.env.SSH_AUTH_SOCK
      } else {
        throw new Error(
          'no private key found: set auth.privateKey, or generate one with `ssh-keygen -t ed25519` '
          + '(tried ~/.ssh/id_ed25519, ~/.ssh/id_ecdsa, ~/.ssh/id_rsa), or switch auth to { "type": "password", "password": "..." }',
        )
      }
      if (auth.passphrase) opts.passphrase = auth.passphrase
    } else {
      opts.password = auth.password || ''
    }
    if (this.signal !== undefined) {
      this.onAbort = () => { this.end() }
      this.signal.addEventListener('abort', this.onAbort)
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const onReady = () => {
        if (settled) return
        settled = true
        this.connected = true
        resolve()
      }
      const onError = (err) => {
        if (settled) return
        settled = true
        reject(new Error(`${err.level || 'SSH'} error: ${err.message || err}`))
      }
      this.client.once('ready', onReady)
      this.client.once('error', onError)
      this.client.connect(opts)
    })
    return this
  }

  /** Run one remote command. Resolves { exitCode, stdout, stderr, timedOut }. */
  exec(cmd, { timeout = 120, sudo = false, password = '' } = {}) {
    const env = this.env
    const useSudo = sudo === true
    return new Promise((resolve) => {
      let out = ''
      let errOut = ''
      // Command output is captured as text for logs/errors; binary or huge output
      // (a tar stream, a giant log dump) must never grow the string unbounded —
      // that froze the whole DSH process when the backup pipeline streamed tar
      // through stdout. Keep the first 256 KB, keep draining the channel.
      const MAX_CAPTURE = 256 * 1024
      const appendChunk = (target, chunk) => {
        if (target.length >= MAX_CAPTURE) return target
        let text
        try { text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) } catch (ignored) { return target }
        const room = MAX_CAPTURE - target.length
        return target + (text.length <= room ? text : text.slice(0, room) + '\n...[output truncated]...\n')
      }
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        if (this.onExec !== null) {
          try {
            this.onExec({ cmd, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut === true })
          } catch (ignored) { /* logging must never break the pipeline */ }
        }
        resolve(result)
      }
      let timer = null
      if (!useSudo) {
        this.client.exec(cmd, (err, stream) => {
          if (err) return finish({ exitCode: -1, stdout: '', stderr: `exec error: ${err.message}`, timedOut: false })
          timer = setTimeout(() => {
            finish({ exitCode: null, stdout: tailText(out), stderr: tailText(errOut), timedOut: true })
            try { stream.close() } catch (ignored) { /* already closed */ }
          }, timeout * 1000)
          stream.on('data', (d) => { out = appendChunk(out, d) })
          stream.stderr.on('data', (d) => { errOut = appendChunk(errOut, d) })
          stream.on('close', (code, signalName) => {
            clearTimeout(timer)
            finish({ exitCode: code, signal: signalName, stdout: tailText(out), stderr: tailText(errOut), timedOut: false })
          })
        })
      } else {
        // sudo -S reads the password from the tty; sh -s reads the command from stdin.
        this.client.exec('sudo -S -p "" sh -s', { pty: true }, (err, stream) => {
          if (err) return finish({ exitCode: -1, stdout: '', stderr: `exec error: ${err.message}`, timedOut: false })
          timer = setTimeout(() => {
            finish({ exitCode: null, stdout: tailText(out), stderr: tailText(errOut), timedOut: true })
            try { stream.close() } catch (ignored) { /* already closed */ }
          }, timeout * 1000)
          stream.on('data', (d) => { out = appendChunk(out, d) })
          stream.stderr.on('data', (d) => { errOut = appendChunk(errOut, d) })
          stream.write(password + '\n')
          stream.write(cmd + '\n')
          stream.end()
          stream.on('close', (code, signalName) => {
            clearTimeout(timer)
            finish({ exitCode: code, signal: signalName, stdout: tailText(out), stderr: tailText(errOut), timedOut: false })
          })
        })
      }
    })
  }

  async sftp() {
    if (this.sftpHandle !== null) return this.sftpHandle
    if (this.sftpPromise === null) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) return reject(new Error(`sftp failed: ${err.message}`))
          this.sftpHandle = sftp
          resolve(sftp)
        })
      })
    }
    return this.sftpPromise
  }

  async sftpStat(remotePath) {
    const sftp = await this.sftp()
    return new Promise((resolve) => {
      sftp.stat(remotePath, (err, stat) => {
        if (err) return resolve(null)
        resolve(stat)
      })
    })
  }

  async sftpMkdirp(remotePath) {
    const sftp = await this.sftp()
    const parts = remotePath.replace(/\\/g, '/').split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      cur += '/' + part
      const exists = await new Promise((resolve) => {
        sftp.stat(cur, (err) => resolve(!err))
      })
      if (!exists) {
        await new Promise((resolve, reject) => {
          sftp.mkdir(cur, (err) => (err ? reject(new Error(`mkdir ${cur}: ${err.message}`)) : resolve()))
        })
      }
    }
  }

  async sftpPut(localPath, remotePath, onProgress) {
    const sftp = await this.sftp()
    await this.sftpMkdirp(path.posix.dirname(remotePath.replace(/\\/g, '/')))
    const options = { ...(this.uploadOptions || {}) }
    if (typeof onProgress === 'function') {
      options.step = (transferred, _chunk, total) => {
        try { onProgress(transferred, total) } catch (ignored) { /* progress must never break the upload */ }
      }
    }
    await new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, options, (err) => (err ? reject(new Error(`upload ${remotePath}: ${err.message}`)) : resolve()))
    })
  }

  /** Write a UTF-8 text file over SFTP (used for generated control scripts). */
  async sftpWriteText(remotePath, content) {
    const sftp = await this.sftp()
    await this.sftpMkdirp(path.posix.dirname(remotePath.replace(/\\/g, '/')))
    await new Promise((resolve, reject) => {
      sftp.open(remotePath, 'w', (err, handle) => {
        if (err) return reject(new Error(`open ${remotePath}: ${err.message}`))
        const buf = Buffer.from(content, 'utf8')
        sftp.write(handle, buf, 0, buf.length, 0, (werr) => {
          sftp.close(handle, () => {})
          if (werr) return reject(new Error(`write ${remotePath}: ${werr.message}`))
          resolve()
        })
      })
    })
  }

  async sftpRmRf(remotePath) {
    const sftp = await this.sftp()
    const stat = await this.sftpStat(remotePath)
    if (stat === null) return
    if (stat.isDirectory()) {
      const list = await new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (err, entries) => (err ? reject(new Error(`readdir ${remotePath}: ${err.message}`)) : resolve(entries || [])))
      })
      for (const entry of list) {
        await this.sftpRmRf(remotePath.replace(/\/+$/, '') + '/' + entry.filename)
      }
      await new Promise((resolve, reject) => {
        sftp.rmdir(remotePath, (err) => (err ? reject(new Error(`rmdir ${remotePath}: ${err.message}`)) : resolve()))
      })
    } else {
      await new Promise((resolve, reject) => {
        sftp.unlink(remotePath, (err) => (err ? reject(new Error(`unlink ${remotePath}: ${err.message}`)) : resolve()))
      })
    }
  }

  async sftpList(remotePath) {
    const sftp = await this.sftp()
    return new Promise((resolve) => {
      sftp.readdir(remotePath, (err, entries) => {
        if (err) return resolve([])
        resolve(entries.map(e => ({ name: e.filename, mtime: e.attrs && e.attrs.mtime ? e.attrs.mtime : 0 })))
      })
    })
  }

  end() {
    if (this.closed) return
    this.closed = true
    try { this.client.end() } catch (ignored) { /* already gone */ }
  }
}

/** Zip a local directory (excluding node_modules/.git/__pycache__) into zipPath. */
function zipLocalDir(srcDir, zipPath) {
  const zip = new AdmZip()
  const root = path.resolve(srcDir)
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === '__pycache__') continue
      const full = path.join(dir, name)
      const rel = prefix === '' ? name : prefix + '/' + name
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        walk(full, rel)
      } else {
        zip.addFile(rel, fs.readFileSync(full))
      }
    }
  }
  walk(root, '')
  zip.writeZip(zipPath)
  return zipPath
}

function sudoOf(env) {
  const useSudo = env.sudo === true
  const password = (env.auth && env.auth.type !== 'key' && typeof env.auth.password === 'string') ? env.auth.password : ''
  return { useSudo, password }
}

async function execCmd(session, env, cmd, timeout) {
  const { useSudo, password } = sudoOf(env)
  return session.exec(cmd, { timeout, sudo: useSudo, password })
}

/** Render one remote command execution as a terminal-ready text block. */
function execLogLines(entry) {
  const lines = ['$ ' + String(entry.cmd || '')]
  const out = String(entry.stdout || '').replace(/\s+$/, '')
  const err = String(entry.stderr || '').replace(/\s+$/, '')
  if (out) lines.push(out)
  if (err) lines.push(err)
  if (entry.timedOut) lines.push('[timed out]')
  return lines.join('\n') + '\n'
}

/** Prefix every non-empty line with a service/instance tag for parallel runs. */
function prefixEachLine(text, prefix) {
  const tag = '[' + prefix + '] '
  return String(text).split('\n').filter(line => line.length > 0).map(line => tag + line).join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Control-script resolution: when `remote.scripts` is configured, the service
// is started/stopped through scripts under `scripts.dir` (relative to the
// deployDir). A missing script is GENERATED from the java-jar template when
// `scripts.autoGenerate` is set; otherwise the configured *Command fields
// (systemctl style) remain the fallback. This is the plugin-side answer to
// "some servers have .sh files, some don't".
// ---------------------------------------------------------------------------

function scriptConfig(env) {
  const s = (env.remote || {}).scripts
  if (s === null || typeof s !== 'object') return null
  const dir = (typeof s.dir === 'string' && s.dir.trim() !== '' ? s.dir.trim() : 'bin').replace(/^\/+|\/+$/g, '')
  return {
    dir,
    names: {
      start: typeof s.start === 'string' && s.start.trim() !== '' ? s.start : 'start.sh',
      stop: typeof s.stop === 'string' && s.stop.trim() !== '' ? s.stop : 'stop.sh',
      restart: typeof s.restart === 'string' && s.restart.trim() !== '' ? s.restart : 'restart.sh',
      status: typeof s.status === 'string' && s.status.trim() !== '' ? s.status : 'status.sh',
    },
    auto: s.autoGenerate !== null && typeof s.autoGenerate === 'object' ? s.autoGenerate : null,
  }
}

function scriptTemplate(kind, env, deployDir, dirAbs) {
  const auto = scriptConfig(env).auto
  const firstArtifact = Array.isArray(env.artifacts) && env.artifacts.length > 0 ? env.artifacts[0] : null
  const jarRel = (auto && typeof auto.jar === 'string' && auto.jar.trim() !== '') ? auto.jar.trim().replace(/^\/+/, '')
    : (firstArtifact && typeof firstArtifact.remote === 'string' ? firstArtifact.remote.replace(/^\/+/, '') : (firstArtifact && typeof firstArtifact.local === 'string' ? path.basename(firstArtifact.local) : 'app.jar'))
  const jarAbs = deployDir + '/' + jarRel
  const javaOpts = auto && typeof auto.javaOpts === 'string' ? auto.javaOpts : ''
  const logRel = auto && typeof auto.logFile === 'string' && auto.logFile.trim() !== '' ? auto.logFile.trim().replace(/^\/+/, '') : 'logs/app.log'
  const logAbs = deployDir + '/' + logRel
  const pidRel = auto && typeof auto.pidFile === 'string' && auto.pidFile.trim() !== '' ? auto.pidFile.trim().replace(/^\/+/, '') : 'app.pid'
  const pidAbs = deployDir + '/' + pidRel
  const header = '#!/bin/sh\n# Generated by dsh-deploy — regenerate by removing this file (config remote.scripts.autoGenerate)\n'
  if (kind === 'start') {
    return header
      + `mkdir -p "$(dirname "${logAbs}")"\n`
      + `if [ -f "${pidAbs}" ] && kill -0 "$(cat "${pidAbs}" 2>/dev/null)" 2>/dev/null; then\n`
      + `  echo "already running (pid $(cat "${pidAbs}"))"\n  exit 0\nfi\n`
      + `nohup java ${javaOpts} -jar "${jarAbs}" >> "${logAbs}" 2>&1 &\n`
      + `echo $! > "${pidAbs}"\n`
      + `echo "started (pid $(cat "${pidAbs}"))"\n`
  }
  if (kind === 'stop') {
    return header
      + `if [ -f "${pidAbs}" ]; then\n`
      + `  PID=$(cat "${pidAbs}" 2>/dev/null)\n`
      + `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then\n`
      + `    kill "$PID"\n`
      + `    i=0\n`
      + `    while kill -0 "$PID" 2>/dev/null && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done\n`
      + `    kill -9 "$PID" 2>/dev/null || true\n`
      + `    echo "stopped (pid $PID)"\n`
      + `  else\n`
      + `    echo "not running (stale pid $PID)"\n`
      + `  fi\n`
      + `  rm -f "${pidAbs}"\n`
      + `else\n`
      + `  echo "no pid file"\n`
      + `fi\n`
  }
  if (kind === 'restart') {
    return header
      + `sh "${dirAbs}/${scriptConfig(env).names.stop}" && sh "${dirAbs}/${scriptConfig(env).names.start}"\n`
  }
  // status
  return header
    + `if [ -f "${pidAbs}" ]; then\n`
    + `  PID=$(cat "${pidAbs}" 2>/dev/null)\n`
    + `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "running (pid $PID)"; exit 0; fi\n`
    + `fi\n`
    + `if pgrep -f "${jarRel}" >/dev/null 2>&1; then echo "running (pgrep ${jarRel})"; exit 0; fi\n`
    + `echo "not running"; exit 1\n`
}

/**
 * Make sure the control script for `kind` (start|stop|restart|status) exists,
 * generating it when configured and missing. Resolves
 * { path, generated } or null when scripts are not configured for this kind.
 */
async function ensureScript(session, env, kind) {
  const cfg = scriptConfig(env)
  if (cfg === null) return null
  const deployDir = String((env.remote || {}).deployDir || '').replace(/\/+$/, '')
  const dirAbs = deployDir + '/' + cfg.dir
  const abs = dirAbs + '/' + cfg.names[kind]
  const stat = await session.sftpStat(abs)
  if (stat !== null && !stat.isDirectory()) return { path: abs, generated: false }
  if (cfg.auto === null) return null
  const content = scriptTemplate(kind, env, deployDir, dirAbs)
  await session.sftpWriteText(abs, content)
  const chmod = await execCmd(session, env, `chmod +x "${abs}"`, 60)
  if (chmod.exitCode !== 0) throw new Error(`chmod +x ${abs} failed: ${chmod.stderr} ${chmod.stdout}`)
  return { path: abs, generated: true }
}

/**
 * Resolve the command that performs `kind` (start|stop|restart|status):
 * control script first (generating it when configured), then the *Command
 * config fields, then a safe fallback. Resolves null only when no control
 * exists for the kind (stop/start without any configured control).
 */
async function controlCommand(session, env, kind) {
  const ensured = await ensureScript(session, env, kind)
  if (ensured !== null) {
    return { command: `sh "${ensured.path}"`, via: ensured.generated ? `generated ${ensured.path}` : `script ${ensured.path}` }
  }
  const remoteCfg = env.remote || {}
  const direct = remoteCfg[kind + 'Command']
  if (typeof direct === 'string' && direct.trim() !== '') {
    return { command: direct, via: kind + 'Command' }
  }
  if (kind === 'status') return { command: 'echo ok', via: 'fallback' }
  return null
}

/** Backup exclusions: only the package files get backed up, never logs/runtime junk. */
function backupExcludes(remoteCfg) {
  if (Array.isArray(remoteCfg.backupExclude)) {
    return remoteCfg.backupExclude.map(String)
  }
  return ['logs', '*.log', 'nohup.out', 'tmp', 'cache', '*.pid']
}

function tarExcludeArgs(excludes) {
  return excludes.map(p => `--exclude=${p}`).join(' ')
}

async function backupRemote(session, env) {
  const remoteCfg = env.remote || {}
  const deployDir = String(remoteCfg.deployDir || '').replace(/\/+$/, '')
  const backupDir = String(remoteCfg.backupDir || (deployDir + '-backups')).replace(/\/+$/, '')
  const keep = Number(remoteCfg.backupKeep || 10)
  // Default is a single uncompressed tar archive: it is written remotely with
  // `tar -cf <archive>` and never streams binary data through the SSH stdout
  // channel (the old copy pipeline did, and a large binary stream froze the
  // local DSH process). `copy` remains available but is staged through a remote
  // temp tar file, still without binary on stdout.
  const mode = remoteCfg.backupMode === 'copy' ? 'copy' : 'tar'
  // gzip on a large deploy dir is the slowest part of a deploy; uncompressed
  // tar (or the copy pipeline) is several times faster and restores the same.
  // Compression is therefore opt-in: set backupCompress:true to get .tar.gz.
  const compress = remoteCfg.backupCompress === true
  const name = path.posix.basename(deployDir) || 'app'
  const stamp = timestamp()
  const excludes = tarExcludeArgs(backupExcludes(remoteCfg))
  if (mode === 'tar') {
    const parent = path.posix.dirname(deployDir) || '/'
    const archive = `${backupDir}/${name}-${stamp}${compress ? '.tar.gz' : '.tar'}`
    const flag = compress ? '-czf' : '-cf'
    const res = await execCmd(session, env, `mkdir -p "${backupDir}" && tar ${flag} "${archive}" -C "${parent}" ${excludes} "${path.posix.basename(deployDir)}"`, 900)
    if (res.exitCode !== 0) throw new Error(`backup(tar) failed: ${res.stderr} ${res.stdout}`)
  } else {
    // copy mode: tar to a remote temp archive, unpack, remove the temp file —
    // nothing but text crosses the SSH channel.
    const tmpArchive = `${backupDir}/.tmp-${name}-${stamp}.tar`
    const destDir = `${backupDir}/${name}-${stamp}`
    const cmd = `mkdir -p "${backupDir}" && tar -C "${deployDir}" ${excludes} -cf "${tmpArchive}" .`
      + ` && mkdir -p "${destDir}" && tar -C "${destDir}" -xf "${tmpArchive}" && rm -f "${tmpArchive}"`
    const res = await execCmd(session, env, cmd, 1800)
    if (res.exitCode !== 0) throw new Error(`backup(copy) failed: ${res.stderr} ${res.stdout}`)
  }
  const backups = (await session.sftpList(backupDir))
    .sort((a, b) => b.mtime - a.mtime)
    .map(e => e.name)
  // Prune with one remote `rm -rf`: recursive SFTP deletion walks every file
  // over the wire (a 1k-file, 300 MB backup took minutes and looked like the
  // backup step hanging).
  const stale = backups.slice(keep)
  let pruned = 0
  if (stale.length > 0) {
    const targets = stale.map(n => `"${backupDir}/${n}"`).join(' ')
    const res = await execCmd(session, env, `rm -rf ${targets}`, 300)
    if (res.exitCode === 0) pruned = stale.length
  }
  return { dir: backupDir, name: `${name}-${stamp}${mode === 'tar' ? (compress ? '.tar.gz' : '.tar') : ''}`, mode, compressed: mode === 'tar' ? compress : false, pruned }
}

async function restoreRemote(session, env) {
  const remoteCfg = env.remote || {}
  const deployDir = String(remoteCfg.deployDir || '').replace(/\/+$/, '')
  const backupDir = String(remoteCfg.backupDir || (deployDir + '-backups')).replace(/\/+$/, '')
  const backups = (await session.sftpList(backupDir)).sort((a, b) => b.mtime - a.mtime).map(e => e.name)
  if (backups.length === 0) throw new Error(`no backups found under ${backupDir}`)
  const latest = backups[0]
  const stopCtl = await controlCommand(session, env, 'stop')
  if (stopCtl !== null) await execCmd(session, env, stopCtl.command, Number(remoteCfg.stopTimeoutSec || 60))
  const full = backupDir + '/' + latest
  let res
  if (latest.endsWith('.tar.gz')) {
    const parent = path.posix.dirname(deployDir) || '/'
    res = await execCmd(session, env, `rm -rf "${deployDir}" && mkdir -p "${deployDir}" && tar -xzf "${full}" -C "${parent}"`, 1800)
  } else if (latest.endsWith('.tar')) {
    const parent = path.posix.dirname(deployDir) || '/'
    res = await execCmd(session, env, `rm -rf "${deployDir}" && mkdir -p "${deployDir}" && tar -xf "${full}" -C "${parent}"`, 1800)
  } else {
    res = await execCmd(session, env, `rm -rf "${deployDir}" && cp -a "${full}" "${deployDir}"`, 1800)
  }
  if (res.exitCode !== 0) throw new Error(`restore failed: ${res.stderr} ${res.stdout}`)
  const startCtl = await controlCommand(session, env, 'start')
  if (startCtl !== null) {
    res = await execCmd(session, env, startCtl.command, 120)
    if (res.exitCode !== 0) throw new Error(`start after restore failed (${startCtl.via}): ${res.stderr} ${res.stdout}`)
  }
  return { backup: latest, deployDir }
}

function httpProbeCmd(url, timeoutSec) {
  return (
    'C=$(curl -sS -o /dev/null -w "%{http_code}" --max-time ' + timeoutSec + ' "' + url + '" 2>/dev/null); '
    + 'if [ -z "$C" ] || [ "$C" = "000" ]; then '
    + 'C=$(wget -q -S -O /dev/null --timeout=' + timeoutSec + ' "' + url + '" 2>&1 | sed -n "s/.*HTTP\\/1\\.[01] \\([0-9][0-9][0-9]\\).*/\\1/p" | head -1); '
    + 'fi; echo "$C"'
  )
}

async function healthCheck(session, env, skip) {
  const hc = (env.remote || {}).healthCheck
  if (skip || !hc || hc.type === undefined || hc.type === 'none') {
    return { type: 'none', skipped: true, ok: true }
  }
  const retries = Math.max(Number(hc.retries || 12), 1)
  const interval = Number(hc.intervalSec || 5)
  if (hc.type === 'http') {
    const url = hc.url
    const expected = String(hc.expectedStatus || 200)
    const timeoutSec = Number(hc.timeoutSec || 5)
    let last = ''
    for (let i = 0; i < retries; i++) {
      const res = await execCmd(session, env, httpProbeCmd(url, timeoutSec), timeoutSec + 15)
      const code = String(res.stdout || '').trim()
      last = code || String(res.stderr || '').trim()
      if (res.exitCode === 0 && code === expected) {
        return { type: 'http', ok: true, status: code, attempts: i + 1 }
      }
      await sleep(interval * 1000)
    }
    return { type: 'http', ok: false, status: last, attempts: retries }
  }
  if (hc.type === 'command') {
    let last = ''
    for (let i = 0; i < retries; i++) {
      const res = await execCmd(session, env, hc.command, Number(hc.timeoutSec || 30))
      last = res.stdout
      if (res.exitCode === 0) return { type: 'command', ok: true, attempts: i + 1, stdout: last }
      await sleep(interval * 1000)
    }
    return { type: 'command', ok: false, attempts: retries, stdout: last }
  }
  return { type: hc.type, ok: false, error: 'unsupported healthCheck type' }
}

function stepEmitter(onStep) {
  let last = nowMs()
  return (step, status, detail, durationMs) => {
    const ev = { step, status, detail, durationMs: durationMs === undefined ? nowMs() - last : durationMs }
    last = nowMs()
    if (typeof onStep === 'function') onStep(ev)
  }
}

/** Full deploy pipeline. Resolves { ok, error, deployDir }. */
async function opDeploy(job, { onStep, signal, log } = {}) {
  const env = job.environment || {}
  const emit = stepEmitter(onStep)
  const onExec = typeof log === 'function' ? (entry) => { log(execLogLines(entry)) } : null
  const session = new SshSession(env, signal, onExec)
  try {
    emit('connect', 'running')
    await session.connect()
    emit('connect', 'ok', `${env.username || 'root'}@${env.host}:${env.port || 22}`)
    const remoteCfg = env.remote || {}
    const deployDir = String(remoteCfg.deployDir || '').replace(/\/+$/, '')
    const staging = String(remoteCfg.stagingDir || '/tmp/dsh-deploy').replace(/\/+$/, '')
    const envType = env.type || 'backend'

    for (const cmd of remoteCfg.preCommands || []) {
      const res = await execCmd(session, env, cmd, 300)
      if (res.exitCode !== 0) throw new Error(`preCommand failed: ${cmd}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
    }

    await execCmd(session, env, `mkdir -p "${staging}"`, 60)
    let uploaded = []
    let localZip = null
    emit('upload', 'running')

    // Throttled upload-progress lines (at most one per second per opDeploy).
    const logText = typeof log === 'function' ? log : () => {}
    const fmtBytes = (b) => {
      const n = Number(b) || 0
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1048576).toFixed(1) + ' MB'
    }
    let lastProgressAt = 0
    const reportProgress = (local, transferred, total) => {
      const t = Number(total) || 0
      const x = Number(transferred) || 0
      if (t <= 0 || x >= t) return // completion is covered by the "uploaded N item(s)" line
      const now = Date.now()
      if (now - lastProgressAt < 1000) return
      lastProgressAt = now
      const pct = Math.round(x * 100 / t)
      logText('上传 ' + path.basename(String(local)) + '：' + pct + '%（' + fmtBytes(x) + ' / ' + fmtBytes(t) + '）\n')
    }

    if (envType === 'frontend') {
      const pkg = env.package || {}
      const src = pkg.local
      if (!src) throw new Error('frontend deploy needs package.local directory')
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`local package directory not found: ${src}`)
      localZip = path.join(os.tmpdir(), `dsh-deploy-${process.pid}-${Date.now()}.zip`)
      try {
        zipLocalDir(src, localZip)
        const remoteZip = staging + '/' + (pkg.remoteName || 'frontend.zip')
        await session.sftpPut(localZip, remoteZip, (transferred, total) => reportProgress(src, transferred, total))
        uploaded = [{ local: src, staged: remoteZip }]
      } finally {
        try { fs.unlinkSync(localZip) } catch (ignored) { /* gone */ }
      }
    } else {
      for (const art of env.artifacts || []) {
        const local = art.local
        if (!local) throw new Error('artifact needs local path')
        if (!fs.existsSync(local) || !fs.statSync(local).isFile()) throw new Error(`artifact file not found: ${local}`)
        const remoteRel = String(art.remote || path.basename(local)).replace(/^\/+/, '')
        const dest = staging + '/' + remoteRel
        await session.sftpPut(local, dest, (transferred, total) => reportProgress(local, transferred, total))
        uploaded.push({ local, staged: dest })
      }
    }
    emit('upload', 'ok', `uploaded ${uploaded.length} item(s) to ${staging}`)

    emit('backup', 'running')
    if (!job.noBackup) {
      const exists = deployDir !== '' && (await session.sftpStat(deployDir)) !== null
      if (exists) {
        const info = await backupRemote(session, env)
        emit('backup', 'ok', `${info.name} @ ${info.dir} (${info.mode === 'tar' ? (info.compressed ? 'tar.gz' : 'tar, uncompressed') : 'copy'}, pruned ${info.pruned})`)
      } else {
        emit('backup', 'skipped', `deployDir ${deployDir} does not exist yet`)
      }
    } else {
      emit('backup', 'skipped', 'noBackup requested')
    }

    emit('stop', 'running')
    const stopCtl = await controlCommand(session, env, 'stop')
    if (stopCtl !== null) {
      const res = await execCmd(session, env, stopCtl.command, Number(remoteCfg.stopTimeoutSec || 60))
      if (res.exitCode !== 0) throw new Error(`stop failed (${stopCtl.via}): ${stopCtl.command}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
      emit('stop', 'ok', (res.stdout || 'service stopped') + ' [' + stopCtl.via + ']')
    } else {
      emit('stop', 'skipped', 'no stop control configured')
    }

    emit('deploy', 'running')
    if (envType === 'frontend') {
      const remoteZip = uploaded[0].staged
      await execCmd(session, env, `mkdir -p "${deployDir}"`, 60)
      if (remoteCfg.clean) {
        const res = await execCmd(session, env, `rm -rf "${deployDir}"/* "${deployDir}"/.[!.]* "${deployDir}"/..?*`, 300)
        if (res.exitCode !== 0) throw new Error(`clean deployDir failed: ${res.stdout} ${res.stderr}`)
      }
      const toolChoice = remoteCfg.unzipTool || 'auto'
      let res = await execCmd(session, env, `unzip -oq "${remoteZip}" -d "${deployDir}"`, 900)
      if (res.exitCode !== 0 && (toolChoice === 'auto' || toolChoice === 'python3')) {
        res = await execCmd(session, env, `python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "${remoteZip}" "${deployDir}"`, 900)
      }
      if (res.exitCode !== 0) throw new Error(`frontend unzip failed: stdout: ${res.stdout} stderr: ${res.stderr}`)
      emit('deploy', 'ok', `extracted ${remoteZip} into ${deployDir}`)
    } else {
      for (const item of uploaded) {
        const remoteRel = item.staged.slice(staging.length).replace(/^\/+/, '')
        const target = deployDir + '/' + remoteRel
        const res = await execCmd(session, env, `mkdir -p "${path.posix.dirname(target)}" && mv -f "${item.staged}" "${target}"`, 300)
        if (res.exitCode !== 0) throw new Error(`mv failed for ${target}: ${res.stdout} ${res.stderr}`)
      }
      emit('deploy', 'ok', `moved ${uploaded.length} artifact(s) into ${deployDir}`)
    }

    for (const cmd of remoteCfg.postCommands || []) {
      const res = await execCmd(session, env, cmd, 300)
      if (res.exitCode !== 0) throw new Error(`postCommand failed: ${cmd}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
    }

    emit('start', 'running')
    const startCtl = await controlCommand(session, env, 'start')
    if (startCtl !== null) {
      const res = await execCmd(session, env, startCtl.command, Number(remoteCfg.startTimeoutSec || 120))
      if (res.exitCode !== 0) throw new Error(`start failed (${startCtl.via}): ${startCtl.command}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
      emit('start', 'ok', (res.stdout || 'service started') + ' [' + startCtl.via + ']')
    } else {
      emit('start', 'skipped', 'no start control configured')
    }

    emit('healthCheck', 'running')
    const hc = await healthCheck(session, env, job.skipHealthCheck)
    if (hc.ok === false) throw new Error(`health check failed: ${JSON.stringify(hc)}`)
    emit('healthCheck', hc.ok === true ? 'ok' : 'skipped', JSON.stringify(hc))

    try { await execCmd(session, env, `rm -rf "${staging}"`, 120) } catch (ignored) { /* best effort */ }
    return { ok: true, deployDir }
  } finally {
    session.end()
  }
}

/** Remote operations without deploying. Resolves the done payload. */
async function opRemote(job, { signal, log } = {}) {
  const env = job.environment || {}
  const action = job.action || 'status'
  const onExec = typeof log === 'function' ? (entry) => { log(execLogLines(entry)) } : null
  const session = new SshSession(env, signal, onExec)
  try {
    await session.connect()
    const remoteCfg = env.remote || {}
    const timeout = Number(job.timeoutSec || 120)
    if (action === 'status') {
      const ctl = await controlCommand(session, env, 'status')
      const res = await execCmd(session, env, ctl.command, timeout)
      return { ok: true, step: 'status', exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, via: ctl.via }
    }
    if (action === 'stop' || action === 'start') {
      const ctl = await controlCommand(session, env, action)
      if (ctl === null) throw new Error(`no ${action} control configured (scripts or ${action}Command)`)
      const res = await execCmd(session, env, ctl.command, timeout)
      return { ok: res.exitCode === 0, step: action, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, via: ctl.via, error: res.exitCode === 0 ? null : `${action} failed (${ctl.via})` }
    }
    if (action === 'restart') {
      const out = {}
      const restartCtl = await ensureScript(session, env, 'restart')
      if (restartCtl !== null) {
        const res = await execCmd(session, env, `sh "${restartCtl.path}"`, timeout)
        out.restart = { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, via: restartCtl.generated ? `generated ${restartCtl.path}` : `script ${restartCtl.path}` }
        if (res.exitCode !== 0) throw new Error(`restart failed: ${res.stdout} ${res.stderr}`)
      } else {
        const stopCtl = await controlCommand(session, env, 'stop')
        const startCtl = await controlCommand(session, env, 'start')
        if (stopCtl !== null) {
          const res = await execCmd(session, env, stopCtl.command, timeout)
          out.stop = { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, via: stopCtl.via }
        }
        if (startCtl !== null) {
          const res = await execCmd(session, env, startCtl.command, timeout)
          out.start = { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, via: startCtl.via }
          if (res.exitCode !== 0) throw new Error(`restart failed on start: ${res.stdout} ${res.stderr}`)
        }
      }
      const hc = await healthCheck(session, env, job.skipHealthCheck)
      return { ok: true, step: 'restart', parts: out, healthCheck: hc }
    }
    if (action === 'backup') {
      const info = await backupRemote(session, env)
      return { ok: true, step: 'backup', backup: info }
    }
    if (action === 'clean-backups') {
      const remoteCfg = env.remote || {}
      const deployDir = String(remoteCfg.deployDir || '').replace(/\/+$/, '')
      const backupDir = String(remoteCfg.backupDir || (deployDir + '-backups')).replace(/\/+$/, '')
      const entries = await session.sftpList(backupDir)
      if (entries.length > 0) {
        const targets = entries.map(e => `"${backupDir}/${e.name}"`).join(' ')
        const res = await execCmd(session, env, `rm -rf ${targets}`, 300)
        if (res.exitCode !== 0) throw new Error(`clean-backups failed: ${res.stderr} ${res.stdout}`)
      }
      return { ok: true, step: 'clean-backups', removed: entries.length, backupDir }
    }
    if (action === 'restore') {
      const info = await restoreRemote(session, env)
      return { ok: true, step: 'restore', restored: info }
    }
    if (action === 'cmd') {
      const cmd = job.command
      if (!cmd) throw new Error('cmd action needs a command')
      const res = await execCmd(session, env, cmd, timeout)
      return { ok: res.exitCode === 0, step: 'cmd', exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, error: res.exitCode === 0 ? null : 'command failed' }
    }
    throw new Error(`unknown action: ${action}`)
  } finally {
    session.end()
  }
}

/**
 * Resolve one service of a `services` environment into a standalone
 * environment object: the parent env supplies connection defaults, the service
 * entry overrides server/auth/type/artifacts/package/remote, and an optional
 * `instance` entry (from `service.instances`) overrides connection + remote
 * fields again — that is how one service deploys to several servers.
 */
function resolveServiceEnv(env, service, instance) {
  const svc = service || {}
  const inst = instance || {}
  const merged = JSON.parse(JSON.stringify(env))
  delete merged.services
  delete merged.continueOnError
  if (svc.name !== undefined) merged.serviceName = svc.name
  for (const key of ['host', 'port', 'username', 'sudo', 'connectTimeout']) {
    if (svc[key] !== undefined) merged[key] = svc[key]
  }
  if (svc.auth !== undefined) merged.auth = svc.auth
  if (svc.type !== undefined) merged.type = svc.type
  if (svc.build !== undefined) merged.build = svc.build
  if (svc.artifacts !== undefined) merged.artifacts = svc.artifacts
  if (svc.package !== undefined) merged.package = svc.package
  if (svc.remote !== undefined) {
    merged.remote = deepMergePlain(merged.remote || {}, svc.remote)
  }
  // instance-level overrides: connection fields and remote commands/dirs only
  for (const key of ['host', 'port', 'username', 'sudo', 'connectTimeout']) {
    if (inst[key] !== undefined) merged[key] = inst[key]
  }
  if (inst.auth !== undefined) merged.auth = inst.auth
  if (inst.remote !== undefined) {
    merged.remote = deepMergePlain(merged.remote || {}, inst.remote)
  }
  // `{{service}}` placeholders in remote command strings resolve to the service name
  const serviceName = typeof svc.name === 'string' ? svc.name : ''
  const substitute = value => (typeof value === 'string' ? value.replaceAll('{{service}}', serviceName) : value)
  if (merged.remote !== null && typeof merged.remote === 'object') {
    for (const key of Object.keys(merged.remote)) {
      const v = merged.remote[key]
      if (typeof v === 'string') merged.remote[key] = substitute(v)
      else if (Array.isArray(v)) merged.remote[key] = v.map(substitute)
    }
  }
  return merged
}

function deepMergePlain(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}))
  const p = patch || {}
  for (const key of Object.keys(p)) {
    const v = p[key]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
      && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMergePlain(out[key], v)
    } else {
      out[key] = v
    }
  }
  return out
}

/**
 * Deploy a `services` environment: run the per-service pipeline for every
 * selected service. A service with an `instances` array deploys once per
 * instance (one build, then one pipeline per server).
 *
 * Set `parallel: true` (optionally with `concurrency: N`, default 4, capped at
 * 8) to deploy independent services — and their instances — concurrently:
 * wall-clock drops from the SUM of service times to roughly the slowest one.
 * `continueOnError` has no meaning in parallel mode, where every selected
 * service is attempted and each failure is reported by name.
 *
 * `buildService(svc, svcEnv)` is a host-supplied callback that runs the local
 * build and resolves { ok, detail, durationMs, error? }. Step events carry a
 * `service` tag and, for instances, the instance `host`/`port`.
 */
async function opDeployMany(job, { onStep, signal, buildService, log } = {}) {
  const env = job.environment || {}
  const services = Array.isArray(env.services) ? env.services : []
  if (services.length === 0) throw new Error('services environment needs a non-empty services array')
  const only = Array.isArray(job.services) && job.services.length > 0 ? new Set(job.services.map(String)) : null
  const continueOnError = env.continueOnError === true
  const selected = services.filter(svc => only === null || only.has(String((svc && svc.name) || '')))
  if (selected.length === 0) {
    throw new Error('no services matched' + (only !== null ? ': ' + [...only].join(', ') : ''))
  }
  const requestedParallel = env.parallel === true || Number(env.concurrency) > 1
  const configured = Number(env.concurrency)
  const limit = requestedParallel ? Math.max(1, Math.min(configured > 1 ? configured : 4, 8)) : 1
  const instanceLimit = requestedParallel ? limit : 1
  const results = new Array(selected.length)
  let allOk = true

  /** One service: optional single build, then each instance's pipeline. */
  async function runService(svc, slot) {
    const name = String((svc && svc.name) || 'service')
    const instances = Array.isArray(svc.instances) && svc.instances.length > 0 ? svc.instances : null
    const svcResult = { name, ok: false, steps: [] }
    if (instances === null) svcResult.instances = null
    let firstError = null
    try {
      const targets = instances === null
        ? [{ inst: null, host: null }]
        : instances.map((inst, index) => ({ inst, host: String(inst && inst.host !== undefined ? inst.host : (svc.host || '')) || `instance-${index + 1}` }))
      const tagFor = (inst, host, instResult) => ev => {
        const tagged = { ...ev, service: name }
        if (inst !== null) {
          tagged.host = host
          const svcEnv = resolveServiceEnv(env, svc, inst)
          const port = svcEnv.port !== undefined && String(svcEnv.port) !== '22' ? String(svcEnv.port) : null
          if (port !== null) tagged.port = port
        }
        if (instResult !== null) instResult.steps.push(tagged)
        svcResult.steps.push(tagged)
        if (typeof onStep === 'function') onStep(tagged)
      }
      const perInstance = targets.map(({ inst, host }) => ({ name, host: inst !== null ? host : null, ok: false, steps: [] }))

      // build once per service (instances share the artifacts), before any instance
      if (typeof buildService === 'function') {
        const firstTarget = targets[0]
        const firstEnv = resolveServiceEnv(env, svc, firstTarget.inst)
        const tag = tagFor(firstTarget.inst, firstTarget.host, perInstance[0])
        tag({ step: 'build', status: 'running' })
        const bres = await buildService(svc, firstEnv)
        tag({ step: 'build', status: bres.ok ? 'ok' : 'failed', detail: bres.detail, durationMs: bres.durationMs })
        if (!bres.ok) throw new Error(bres.error || `build failed for service ${name}`)
      }

      let cursor = 0
      const deployInstance = async () => {
        while (true) {
          const index = cursor++
          if (index >= targets.length) return
          const { inst, host } = targets[index]
          const svcEnv = resolveServiceEnv(env, svc, inst)
          const instanceLog = typeof log === 'function'
            ? (text) => { log(prefixEachLine(text, inst !== null ? `${name}@${host}` : name)) }
            : undefined
          try {
            const res = await opDeploy(
              { environment: svcEnv, noBackup: !!job.noBackup, skipHealthCheck: !!job.skipHealthCheck },
              { signal, onStep: tagFor(inst, host, perInstance[index]), log: instanceLog },
            )
            perInstance[index].ok = true
            perInstance[index].deployDir = res.deployDir
          } catch (error) {
            perInstance[index].error = String(error && error.message ? error.message : error)
            firstError = firstError ?? perInstance[index].error
            if (!continueOnError) return
          }
        }
      }
      if (instanceLimit > 1 && targets.length > 1) {
        await Promise.all(Array.from({ length: Math.min(instanceLimit, targets.length) }, deployInstance))
      } else {
        await deployInstance()
      }

      svcResult.ok = perInstance.length > 0 && perInstance.every(item => item.ok)
      if (instances !== null) {
        svcResult.instances = perInstance
        svcResult.error = firstError
      } else if (perInstance[0] !== undefined) {
        svcResult.deployDir = perInstance[0].deployDir
        svcResult.error = perInstance[0].error
      }
    } catch (error) {
      svcResult.error = String(error && error.message ? error.message : error)
    }
    results[slot] = svcResult
    if (!svcResult.ok) allOk = false
  }

  if (limit === 1) {
    for (let i = 0; i < selected.length; i++) {
      await runService(selected[i], i)
      if (results[i] !== undefined && !results[i].ok && !continueOnError) break
    }
  } else {
    let cursor = 0
    const workers = Array.from({ length: Math.min(limit, selected.length) }, async () => {
      while (true) {
        const slot = cursor++
        if (slot >= selected.length) return
        await runService(selected[slot], slot)
      }
    })
    await Promise.all(workers)
  }
  return { ok: allOk, services: results.filter(item => item !== undefined) }
}

module.exports = { opDeploy, opRemote, opDeployMany, resolveServiceEnv, SshSession, zipLocalDir, tailText }
