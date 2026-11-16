// Quick check: sftpPut fires throttled progress against the fake server.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { SshSession } = require('../engine.cjs')

async function main() {
  // 5 MB temp file (large enough to trigger several chunk callbacks).
  const big = path.join(os.tmpdir(), 'dsh-progress-test.bin')
  fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024, 7))

  const session = new SshSession({
    host: '127.0.0.1', port: 2222, username: 'root', auth: { type: 'password', password: 'x' },
    remote: {},
  }, undefined)
  await session.connect()

  const calls = []
  await session.sftpPut(big, '/tmp/progress-test.bin', (transferred, total) => {
    calls.push({ transferred, total })
  })
  session.end()
  fs.unlinkSync(big)

  if (calls.length === 0) throw new Error('no progress callbacks fired')
  const last = calls[calls.length - 1]
  if (last.total !== 5 * 1024 * 1024) throw new Error('total bytes wrong: ' + last.total)
  if (last.transferred !== 5 * 1024 * 1024) throw new Error('final transferred wrong: ' + last.transferred)
  const increasing = calls.every((c, i) => i === 0 || c.transferred >= calls[i - 1].transferred)
  if (!increasing) throw new Error('progress not monotonic')
  console.log('PROGRESS OK: ' + calls.length + ' step callbacks, final ' + last.transferred + '/' + last.total + ' bytes')
}

main().catch(err => {
  console.error('PROGRESS FAILED:', err && err.message ? err.message : err)
  process.exit(1)
})
