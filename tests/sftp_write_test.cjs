// Isolate the ensureScript hang: connect + write one script via sftpWriteText.
'use strict'
const path = require('node:path')
const { SshSession } = require('../engine.cjs')

const ENV = {
  host: '127.0.0.1', port: 2222, username: 'root',
  auth: { type: 'password', password: 'x' }, sudo: false,
  remote: { deployDir: '/opt/sc', scripts: { dir: 'bin', autoGenerate: { jar: 'x.jar' } } },
}

async function main() {
  const session = new SshSession(ENV)
  await session.connect()
  console.log('connected')
  const sftp = await session.sftp()
  console.log('sftp ok')
  await session.sftpMkdirp('/opt/sc/bin')
  console.log('mkdirp ok')
  await session.sftpWriteText('/opt/sc/bin/start.sh', '#!/bin/sh\necho hi\n')
  console.log('write ok')
  const st = await session.sftpStat('/opt/sc/bin/start.sh')
  console.log('stat:', st !== null, st !== null ? st.size : null)
  session.end()
  console.log('DONE')
}

main().then(() => process.exit(0)).catch(err => {
  console.error('FAILED:', err && err.message ? err.message : err)
  process.exit(1)
})
