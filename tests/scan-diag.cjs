// Diagnose the client-modules resolution for the dsh-deploy row, replicating
// resolveSource/resolveMeta/locatePkgJson against the real Node internal loader.
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { createRequire } = require('node:module')
const { ModuleLoader } = require('D:/traeProjects/deepseek-harness/vendor/loader/lib/types/internal.js')

const baseUrl = pathToFileURL('C:/Users/EDY/.dsh/profiles/web/cordis.yml').href
const loaderName = 'dsh-deploy'

const internal = ModuleLoader.fromInternal()
console.log('internal loader version:', internal && internal.version)

// 1) require-resolution check (createRequire from profile dir)
try {
  const req = createRequire(baseUrl)
  const pkgJsonPath = req.resolve('dsh-deploy/package.json')
  console.log('createRequire resolved package.json:', pkgJsonPath)
} catch (err) {
  console.log('createRequire FAILED:', err.message)
}

// 2) internal resolveSync, as locatePkgJson does
let moduleUrl
try {
  if (internal && internal.version === 'v2') {
    moduleUrl = internal.resolveSync(baseUrl, { specifier: loaderName, attributes: {} }).url
  } else if (internal) {
    moduleUrl = internal.resolveSync(loaderName, baseUrl, {}).url
  } else {
    console.log('no internal loader')
    process.exit(0)
  }
  console.log('resolveSync url:', moduleUrl)
} catch (err) {
  console.log('resolveSync FAILED:', err.message)
  process.exit(0)
}

// 3) nearestPackage walk
function nearestPackage(moduleUrl, expectedPackageName) {
  if (!moduleUrl.startsWith('file:')) return undefined
  let dir = path.dirname(fileURLToPath(moduleUrl))
  while (true) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      try {
        const name = JSON.parse(fs.readFileSync(candidate, 'utf8')).name
        if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
          return { path: candidate, packageName: name }
        }
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
console.log('nearestPackage:', nearestPackage(moduleUrl, 'dsh-deploy'))
