// Node-engine end-to-end test against the fake SSH/SFTP server (tests/fake_ssh_server.py
// on 127.0.0.1:2222). Exercises the ssh2/adm-zip pipeline: connect, zip upload,
// backup, stop, unzip deploy, start, http health check, restore, restart.
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { opDeploy, opRemote } = require('../engine.cjs')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist_sample')

const ENV = {
  host: '127.0.0.1',
  port: 2222,
  username: 'root',
  auth: { type: 'password', password: 'x' },
  sudo: false,
  type: 'frontend',
  package: { local: DIST, remoteName: 'web.zip' },
  remote: {
    deployDir: '/opt/web',
    stagingDir: '/tmp/dsh-deploy',
    backupDir: '/opt/backups/web',
    backupMode: 'copy',
    backupKeep: 3,
    clean: false,
    unzipTool: 'auto',
    preCommands: ['echo pre-ok'],
    stopCommand: 'echo service-stopped',
    startCommand: 'echo service-started',
    statusCommand: 'echo running',
    postCommands: ['echo post-ok'],
    healthCheck: {
      type: 'http',
      url: 'http://127.0.0.1/index.html',
      expectedStatus: '200',
      retries: 3,
      intervalSec: 1,
      timeoutSec: 3,
    },
  },
}

async function main() {
  const steps = []
  const logs = []
  const result = await opDeploy(
    { environment: ENV, noBackup: false, skipHealthCheck: false },
    {
      onStep: ev => { steps.push(ev); console.log('STEP:', ev.step, ev.status, '|', ev.detail || '') },
      log: text => logs.push(text),
    },
  )
  console.log('DEPLOY RESULT:', JSON.stringify(result))
  if (!result.ok) throw new Error('deploy failed: ' + result.error)
  if (steps.length === 0) throw new Error('no steps emitted')
  const joinedLog = logs.join('')
  if (!joinedLog.includes('$ ')) throw new Error('log tee never captured a command echo')
  if (!joinedLog.includes('mkdir')) throw new Error('log tee missing mkdir command output')
  console.log('log tee OK (' + logs.length + ' blocks, ' + joinedLog.split('\n').filter(Boolean).length + ' lines)')

  const status = await opRemote({ environment: ENV, action: 'status', timeoutSec: 10 })
  console.log('STATUS:', JSON.stringify(status))
  if (!status.ok || String(status.stdout).trim() !== 'running') throw new Error('status failed')

  const backup = await opRemote({ environment: ENV, action: 'backup' })
  console.log('BACKUP:', JSON.stringify(backup))
  if (!backup.ok) throw new Error('backup failed')

  const restore = await opRemote({ environment: ENV, action: 'restore' })
  console.log('RESTORE:', JSON.stringify(restore))
  if (!restore.ok) throw new Error('restore failed')

  const restart = await opRemote({ environment: ENV, action: 'restart' })
  console.log('RESTART:', JSON.stringify(restart))
  if (!restart.ok) throw new Error('restart failed')

  // verify deployed artifacts in the fake server's virtual root
  const virtual = path.join(ROOT, 'virtual-root-2222', 'opt', 'web', 'index.html')
  if (!fs.existsSync(virtual)) throw new Error('deployed index.html missing from virtual root')
  const content = fs.readFileSync(virtual, 'utf8')
  if (!content.includes('hello test deploy')) throw new Error('deployed content mismatch')

  console.log('ENGINE E2E PASSED: deploy/status/backup/restore/restart + artifacts verified')

  // ---- backup excludes logs: only package files land in the backup ----
  const BK_ENV = {
    host: '127.0.0.1',
    port: 2222,
    username: 'root',
    auth: { type: 'password', password: 'x' },
    sudo: false,
    type: 'backend',
    artifacts: [
      { local: path.join(DIST, 'index.html'), remote: 'app/index.html' },
      { local: path.join(ROOT, 'app.log'), remote: 'logs/app.log' },
    ],
    remote: {
      deployDir: '/opt/bk',
      stagingDir: '/tmp/dsh-deploy',
      backupDir: '/opt/backups/bk',
      backupMode: 'copy',
      backupKeep: 5,
      stopCommand: 'echo stopped',
      startCommand: 'echo started',
      healthCheck: { type: 'none' },
    },
  }
  const deployBk = await opDeploy({ environment: BK_ENV, noBackup: true, skipHealthCheck: true }, { onStep: () => {} })
  if (!deployBk.ok) throw new Error('bk deploy failed')
  // start from a clean backup dir so re-runs on a dirty virtual root behave
  fs.rmSync(path.join(ROOT, 'virtual-root-2222', 'opt', 'backups', 'bk'), { recursive: true, force: true })
  const backupBk = await opRemote({ environment: BK_ENV, action: 'backup' })
  console.log('BK BACKUP:', JSON.stringify(backupBk))
  if (!backupBk.ok) throw new Error('bk backup failed')
  const bkRoot = path.join(ROOT, 'virtual-root-2222', 'opt', 'backups', 'bk')
  const entries = fs.readdirSync(bkRoot)
  if (entries.length !== 1) throw new Error('expected exactly one backup entry, got ' + JSON.stringify(entries))
  const backupEntry = path.join(bkRoot, entries[0])
  if (!fs.existsSync(path.join(backupEntry, 'app', 'index.html'))) throw new Error('backup missing package file app/index.html')
  if (fs.existsSync(path.join(backupEntry, 'logs', 'app.log'))) throw new Error('backup contains logs/app.log → logs must be excluded')
  console.log('backup exclusion OK (package files kept, logs excluded)')

  const clean = await opRemote({ environment: BK_ENV, action: 'clean-backups' })
  console.log('CLEAN-BACKUPS:', JSON.stringify(clean))
  if (!clean.ok || clean.removed !== 1) throw new Error('clean-backups wrong: ' + JSON.stringify(clean))
  if (fs.readdirSync(bkRoot).length !== 0) throw new Error('backup dir not empty after clean-backups')
  console.log('clean-backups OK (old backups removed)')

  // ---- tar mode: same exclusion inside the compressed archive ----
  const zlib = require('node:zlib')
  const BK_TAR = JSON.parse(JSON.stringify(BK_ENV))
  BK_TAR.remote = { ...BK_TAR.remote, backupMode: 'tar', backupCompress: true }
  const backupTar = await opRemote({ environment: BK_TAR, action: 'backup' })
  console.log('BK TAR BACKUP:', JSON.stringify(backupTar))
  if (!backupTar.ok) throw new Error('tar backup failed')
  const tarEntries = fs.readdirSync(bkRoot).filter(n => n.endsWith('.tar.gz'))
  if (tarEntries.length !== 1) throw new Error('expected one tar.gz backup, got ' + JSON.stringify(tarEntries))
  const plain = zlib.gunzipSync(fs.readFileSync(path.join(bkRoot, tarEntries[0]))).toString('latin1')
  if (plain.includes('logs/app.log')) throw new Error('tar backup contains logs/app.log → logs must be excluded')
  if (!plain.includes('app/index.html')) throw new Error('tar backup missing app/index.html')
  console.log('tar-mode exclusion OK (compressed archive excludes logs)')

  // ---- tar mode with compression left unset → plain .tar is the default ----
  for (const n of fs.readdirSync(bkRoot)) fs.rmSync(path.join(bkRoot, n), { recursive: true, force: true })
  const BK_PLAIN = JSON.parse(JSON.stringify(BK_ENV))
  BK_PLAIN.remote = { ...BK_PLAIN.remote, backupMode: 'tar' }
  const backupPlain = await opRemote({ environment: BK_PLAIN, action: 'backup' })
  console.log('BK PLAIN TAR:', JSON.stringify(backupPlain))
  if (!backupPlain.ok) throw new Error('plain tar backup failed: ' + JSON.stringify(backupPlain))
  if (backupPlain.backup.compressed !== false) throw new Error('plain tar backup should report compressed:false')
  const plainEntries = fs.readdirSync(bkRoot).filter(n => n.endsWith('.tar'))
  if (plainEntries.length !== 1) throw new Error('expected one .tar backup, got ' + JSON.stringify(fs.readdirSync(bkRoot)))
  const plainBuf = fs.readFileSync(path.join(bkRoot, plainEntries[0]))
  if (plainBuf[0] === 0x1f && plainBuf[1] === 0x8b) throw new Error('uncompressed backup is still gzip')
  const plainRaw = plainBuf.toString('latin1')
  if (plainRaw.includes('logs/app.log')) throw new Error('plain tar backup contains logs/app.log → logs must be excluded')
  if (!plainRaw.includes('app/index.html')) throw new Error('plain tar backup missing app/index.html')
  const restorePlain = await opRemote({ environment: BK_PLAIN, action: 'restore' })
  console.log('BK PLAIN RESTORE:', JSON.stringify(restorePlain))
  if (!restorePlain.ok) throw new Error('restore from plain .tar failed: ' + JSON.stringify(restorePlain))
  if (!fs.existsSync(path.join(ROOT, 'virtual-root-2222', 'opt', 'bk', 'app', 'index.html'))) {
    throw new Error('restore from plain .tar did not put app/index.html back')
  }
  console.log('plain-tar backup OK (no gzip magic, logs excluded, restores)')

  // ---- control scripts: use existing, generate when missing, fall back otherwise ----
  const SC_ENV = {
    host: '127.0.0.1',
    port: 2222,
    username: 'root',
    auth: { type: 'password', password: 'x' },
    sudo: false,
    type: 'backend',
    artifacts: [{ local: path.join(ROOT, 'app.log'), remote: 'app.log' }],
    remote: {
      deployDir: '/opt/sc',
      stagingDir: '/tmp/dsh-deploy',
      backupDir: '/opt/backups/sc',
      scripts: {
        dir: 'bin',
        autoGenerate: { jar: 'app.log', javaOpts: '-Xmx256m', logFile: 'logs/app.log', pidFile: 'app.pid' },
      },
      stopCommand: 'echo fallback-stop',
      startCommand: 'echo fallback-start',
      statusCommand: 'echo fallback-status',
      healthCheck: { type: 'none' },
    },
  }
  const scSteps = []
  // deterministic re-runs: no pre-existing scripts, so generation must happen
  fs.rmSync(path.join(ROOT, 'virtual-root-2222', 'opt', 'sc'), { recursive: true, force: true })
  const scDeploy = await opDeploy(
    { environment: SC_ENV, noBackup: true, skipHealthCheck: true },
    { onStep: ev => scSteps.push(ev) },
  )
  console.log('SC DEPLOY:', JSON.stringify(scDeploy))
  if (!scDeploy.ok) throw new Error('scripts deploy failed')
  const stopStep = scSteps.find(s => s.step === 'stop' && s.status === 'ok')
  const startStep = scSteps.find(s => s.step === 'start' && s.status === 'ok')
  if (!stopStep || !String(stopStep.detail).includes('generated /opt/sc/bin/stop.sh')) throw new Error('stop should use the GENERATED stop.sh: ' + JSON.stringify(stopStep))
  if (!String(stopStep.detail).includes('sh:stop.sh')) throw new Error('stop should invoke the script: ' + JSON.stringify(stopStep))
  if (!startStep || !String(startStep.detail).includes('generated /opt/sc/bin/start.sh')) throw new Error('start should use the GENERATED start.sh: ' + JSON.stringify(startStep))
  const scBin = path.join(ROOT, 'virtual-root-2222', 'opt', 'sc', 'bin')
  for (const f of ['start.sh', 'stop.sh']) {
    if (!fs.existsSync(path.join(scBin, f))) throw new Error('generated script missing: ' + f)
  }
  const startSh = fs.readFileSync(path.join(scBin, 'start.sh'), 'utf8')
  if (!startSh.includes('nohup java -Xmx256m -jar "/opt/sc/app.log"')) throw new Error('generated start.sh template wrong:\n' + startSh)
  console.log('script generation OK (stop/start .sh generated from template)')

  // second deploy: scripts now exist → reused, not regenerated
  const scSteps2 = []
  const scDeploy2 = await opDeploy(
    { environment: SC_ENV, noBackup: true, skipHealthCheck: true },
    { onStep: ev => scSteps2.push(ev) },
  )
  if (!scDeploy2.ok) throw new Error('second scripts deploy failed')
  const stopStep2 = scSteps2.find(s => s.step === 'stop' && s.status === 'ok')
  if (!String(stopStep2.detail).includes('script /opt/sc/bin/stop.sh') || String(stopStep2.detail).includes('generated')) {
    throw new Error('second deploy should REUSE the existing script: ' + JSON.stringify(stopStep2))
  }
  console.log('script reuse OK (existing .sh used directly, no regeneration)')

  const scStatus = await opRemote({ environment: SC_ENV, action: 'status' })
  console.log('SC STATUS:', JSON.stringify(scStatus))
  if (!scStatus.ok || !String(scStatus.stdout).includes('sh:status.sh')) throw new Error('status should use status.sh')
  const scRestart = await opRemote({ environment: SC_ENV, action: 'restart' })
  console.log('SC RESTART:', JSON.stringify(scRestart))
  if (!scRestart.ok || !String(scRestart.parts && scRestart.parts.restart && scRestart.parts.restart.stdout).includes('sh:restart.sh')) {
    throw new Error('restart should use restart.sh')
  }
  for (const f of ['restart.sh', 'status.sh']) {
    if (!fs.existsSync(path.join(scBin, f))) throw new Error('generated script missing: ' + f)
  }
  console.log('script status/restart OK')

  // no scripts config → falls back to *Command fields (unchanged behavior)
  const FALLBACK_ENV = JSON.parse(JSON.stringify(SC_ENV))
  delete FALLBACK_ENV.remote.scripts
  const fbSteps = []
  const fbDeploy = await opDeploy(
    { environment: FALLBACK_ENV, noBackup: true, skipHealthCheck: true },
    { onStep: ev => fbSteps.push(ev) },
  )
  if (!fbDeploy.ok) throw new Error('fallback deploy failed')
  const fbStop = fbSteps.find(s => s.step === 'stop' && s.status === 'ok')
  if (!String(fbStop.detail).includes('fallback-stop')) throw new Error('fallback stopCommand should be used: ' + JSON.stringify(fbStop))
  console.log('fallback OK (no scripts config → stopCommand/startCommand as before)')

  console.log('BACKUP EXCLUSION E2E PASSED')
}

main().catch(err => {
  console.error('ENGINE E2E FAILED:', err && err.message ? err.message : err)
  process.exit(1)
})
