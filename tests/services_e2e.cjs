// Microservices-mode e2e: two fake SSH servers (2222, 2223), one services
// environment with abc→server1 and def→server2, a partial-failure run, and a
// subset-only run. Verifies resolveServiceEnv, per-service build callbacks,
// per-server deployment, continueOnError semantics, and step service tags.
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { opDeployMany, resolveServiceEnv } = require('../engine.cjs')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist_sample')

const ENV = {
  host: '127.0.0.1',
  username: 'root',
  auth: { type: 'password', password: 'x' },
  sudo: false,
  type: 'backend',
  remote: {
    stagingDir: '/tmp/dsh-deploy',
    backupMode: 'copy',
    backupKeep: 3,
    stopCommand: 'echo service-stopped',
    startCommand: 'echo service-started',
    statusCommand: 'echo running',
    healthCheck: { type: 'http', url: 'http://127.0.0.1/index.html', expectedStatus: '200', retries: 3, intervalSec: 1, timeoutSec: 3 },
  },
  services: [
    {
      name: 'abc',
      host: '127.0.0.1',
      port: 2222,
      artifacts: [{ local: DIST + '/index.html', remote: 'index.html' }],
      remote: { deployDir: '/opt/abc', backupDir: '/opt/backups/abc' },
    },
    {
      name: 'def',
      host: '127.0.0.1',
      port: 2223,
      artifacts: [{ local: DIST + '/assets/app.js', remote: 'app.js' }],
      remote: { deployDir: '/opt/def', backupDir: '/opt/backups/def' },
    },
  ],
}

async function main() {
  // pure merge check
  const resolved = resolveServiceEnv(ENV, ENV.services[0])
  if (resolved.port !== 2222 || resolved.serviceName !== 'abc' || resolved.remote.deployDir !== '/opt/abc' || resolved.remote.stopCommand !== 'echo service-stopped') {
    throw new Error('resolveServiceEnv merge wrong: ' + JSON.stringify(resolved))
  }
  console.log('resolveServiceEnv OK (server override + remote merge + inheritance)')

  // full deploy: both services to different servers
  const steps = []
  let buildCalls = 0
  const result = await opDeployMany(
    { environment: ENV, noBackup: false, skipHealthCheck: false },
    {
      onStep: ev => { steps.push(ev); console.log('STEP:', ev.service, ev.step, ev.status) },
      async buildService(svc, svcEnv) {
        buildCalls += 1
        return { ok: true, detail: `build ${svc.name} ok`, durationMs: 1 }
      },
    },
  )
  console.log('FULL RESULT:', JSON.stringify(result))
  if (!result.ok || result.services.length !== 2 || result.services.some(s => !s.ok)) throw new Error('full deploy failed')
  if (buildCalls !== 2) throw new Error('build callback count wrong: ' + buildCalls)
  if (!steps.some(s => s.service === 'abc' && s.step === 'deploy' && s.status === 'ok')) throw new Error('abc deploy step missing')
  if (!steps.some(s => s.service === 'def' && s.step === 'deploy' && s.status === 'ok')) throw new Error('def deploy step missing')
  // verify artifacts landed on BOTH servers' virtual roots
  const abcFile = path.join(ROOT, 'virtual-root-2222', 'opt', 'abc', 'index.html')
  const defFile = path.join(ROOT, 'virtual-root-2223', 'opt', 'def', 'app.js')
  if (!fs.existsSync(abcFile)) throw new Error('abc artifact missing on server 1')
  if (!fs.existsSync(defFile)) throw new Error('def artifact missing on server 2')
  console.log('multi-server artifacts verified (abc→server1, def→server2)')

  // subset deploy: only abc
  const subSteps = []
  const sub = await opDeployMany(
    { environment: ENV, services: ['abc'], noBackup: true, skipHealthCheck: false },
    { onStep: ev => subSteps.push(ev), async buildService() { return { ok: true, detail: '', durationMs: 1 } } },
  )
  console.log('SUBSET RESULT:', JSON.stringify(sub))
  if (!sub.ok || sub.services.length !== 1 || sub.services[0].name !== 'abc') throw new Error('subset deploy wrong')
  if (subSteps.some(s => s.service === 'def')) throw new Error('def should not be deployed in subset run')
  console.log('subset deploy OK (only abc)')

  // partial failure: def's stop command fails → batch stops (continueOnError false)
  const brokenEnv = JSON.parse(JSON.stringify(ENV))
  brokenEnv.services[1].remote = { ...brokenEnv.services[1].remote, stopCommand: 'echo ok && exit 7' }
  const failSteps = []
  const fail = await opDeployMany(
    { environment: brokenEnv, noBackup: true, skipHealthCheck: false },
    { onStep: ev => failSteps.push(ev), async buildService() { return { ok: true, detail: '', durationMs: 1 } } },
  )
  console.log('FAILURE RESULT:', JSON.stringify(fail))
  if (fail.ok) throw new Error('expected overall failure')
  if (!fail.services.some(s => !s.ok && s.name === 'def')) throw new Error('def should have failed')
  // continueOnError=true → both attempted
  const contEnv = JSON.parse(JSON.stringify(brokenEnv))
  contEnv.continueOnError = true
  const cont = await opDeployMany(
    { environment: contEnv, noBackup: true, skipHealthCheck: false },
    { onStep: () => {}, async buildService() { return { ok: true, detail: '', durationMs: 1 } } },
  )
  console.log('CONTINUE RESULT:', JSON.stringify(cont))
  if (cont.ok || cont.services.length !== 2 || cont.services.filter(s => !s.ok).length !== 1) throw new Error('continueOnError semantics wrong')
  console.log('partial-failure semantics OK (stop at first failure / continueOnError)')

  // multi-instance: service `multi` on BOTH servers, plus a normal single service
  const instEnv = JSON.parse(JSON.stringify(ENV))
  instEnv.services = [
    {
      name: 'multi',
      artifacts: [{ local: DIST + '/index.html', remote: 'index.html' }],
      remote: { deployDir: '/opt/multi', backupDir: '/opt/backups/multi' },
      instances: [
        { host: '127.0.0.1', port: 2222 },
        { host: '127.0.0.1', port: 2223 },
      ],
    },
    {
      name: 'solo',
      host: '127.0.0.1',
      port: 2222,
      artifacts: [{ local: DIST + '/assets/app.js', remote: 'app.js' }],
      remote: { deployDir: '/opt/solo' },
    },
  ]
  let builds = 0
  const instSteps = []
  const inst = await opDeployMany(
    { environment: instEnv, noBackup: true, skipHealthCheck: false },
    {
      onStep: ev => instSteps.push(ev),
      async buildService() { builds += 1; return { ok: true, detail: '', durationMs: 1 } },
    },
  )
  console.log('INSTANCES RESULT:', JSON.stringify(inst))
  if (!inst.ok || inst.services.length !== 2) throw new Error('instances deploy failed')
  const multi = inst.services.find(s => s.name === 'multi')
  if (!multi || !Array.isArray(multi.instances) || multi.instances.length !== 2 || multi.instances.some(i => !i.ok)) throw new Error('multi instances wrong')
  if (builds !== 2) throw new Error('build must run once per service (got ' + builds + ')')
  if (!instSteps.some(s => s.service === 'multi' && s.host === '127.0.0.1' && s.step === 'deploy' && s.status === 'ok')) throw new Error('multi@server1 steps missing')
  if (!instSteps.some(s => s.service === 'multi' && s.host === '127.0.0.1' && s.step === 'healthCheck')) throw new Error('multi@server2 steps missing')
  // both servers received the artifact
  if (!fs.existsSync(path.join(ROOT, 'virtual-root-2222', 'opt', 'multi', 'index.html'))) throw new Error('multi artifact missing on server 1')
  if (!fs.existsSync(path.join(ROOT, 'virtual-root-2223', 'opt', 'multi', 'index.html'))) throw new Error('multi artifact missing on server 2')
  if (!fs.existsSync(path.join(ROOT, 'virtual-root-2222', 'opt', 'solo', 'app.js'))) throw new Error('solo artifact missing')
  console.log('multi-instance deploy OK (one build, two servers, host-tagged steps)')

  // ---- parallel mode: services deploy concurrently (default stays serial) ----
  const parEnv = JSON.parse(JSON.stringify(ENV))
  parEnv.parallel = true
  const parSteps = []
  const parLogs = []
  let live = 0
  let peak = 0
  let releaseGate = null
  const gate = new Promise(resolve => { releaseGate = resolve })
  let watchdog = null
  const guard = new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error('parallel builds never overlapped — services ran sequentially')), 8000)
  })
  const parPromise = opDeployMany(
    { environment: parEnv, noBackup: true, skipHealthCheck: false },
    {
      onStep: ev => parSteps.push(ev),
      log: text => parLogs.push(text),
      async buildService(svc) {
        live += 1
        peak = Math.max(peak, live)
        if (live >= 2 && releaseGate !== null) releaseGate()
        // both services must be inside their build at the same time to get past this
        await gate
        live -= 1
        return { ok: true, detail: 'build ' + svc.name, durationMs: 1 }
      },
    },
  )
  parPromise.catch(() => {}) // avoid an unhandled rejection if the guard wins the race
  await Promise.race([gate, guard])
  clearTimeout(watchdog)
  const par = await parPromise
  console.log('PARALLEL RESULT:', JSON.stringify(par), 'peak=' + peak)
  if (!par.ok || par.services.length !== 2 || par.services.some(s => !s.ok)) throw new Error('parallel deploy failed')
  if (peak < 2) throw new Error('expected 2 concurrent service builds, peak=' + peak)
  const parJoined = parLogs.join('')
  if (!parJoined.includes('[abc]')) throw new Error('parallel log missing [abc] prefix: ' + parJoined.slice(0, 200))
  if (!parJoined.includes('[def]')) throw new Error('parallel log missing [def] prefix')
  if (!parJoined.includes('$ ')) throw new Error('parallel log missing command echo')
  const runningBuilds = parSteps.filter(s => s.step === 'build' && s.status === 'running')
  const okBuilds = parSteps.filter(s => s.step === 'build' && s.status === 'ok')
  if (runningBuilds.length !== 2 || okBuilds.length !== 2) throw new Error('parallel build steps wrong: ' + JSON.stringify(parSteps.filter(s => s.step === 'build')))
  if (parSteps.indexOf(okBuilds[0]) < parSteps.lastIndexOf(runningBuilds[0])) {
    throw new Error('the first build finished before the second one started — not concurrent')
  }
  if (!fs.existsSync(abcFile) || !fs.existsSync(defFile)) throw new Error('parallel deploy did not reach both servers')
  console.log('parallel deploy OK (both services built and deployed concurrently)')

  // concurrency:1 forces the serial path even with a services environment
  const seqEnv = JSON.parse(JSON.stringify(ENV))
  seqEnv.concurrency = 1
  let seqLive = 0
  let seqPeak = 0
  const seq = await opDeployMany(
    { environment: seqEnv, noBackup: true, skipHealthCheck: false },
    {
      onStep: () => {},
      async buildService() {
        seqLive += 1
        seqPeak = Math.max(seqPeak, seqLive)
        await new Promise(r => setTimeout(r, 30))
        seqLive -= 1
        return { ok: true, detail: '', durationMs: 1 }
      },
    },
  )
  console.log('SEQUENTIAL RESULT:', JSON.stringify(seq), 'peak=' + seqPeak)
  if (!seq.ok) throw new Error('concurrency:1 deploy failed')
  if (seqPeak !== 1) throw new Error('concurrency:1 must serialize services, peak=' + seqPeak)
  console.log('concurrency:1 OK (services serialized on demand)')

  console.log('SERVICES E2E PASSED')
}

main().catch(err => {
  console.error('SERVICES E2E FAILED:', err && err.message ? err.message : err)
  process.exit(1)
})
