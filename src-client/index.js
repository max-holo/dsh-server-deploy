// dsh-server-deploy client plugin: opens the live deploy terminal in the right
// sidebar and drives its input.
//
// The host creates ONE stable terminal per Session (the sidebar merges page tabs
// of the same kind, so a fresh id per run would leave the visible tab pointing
// at a closed terminal) and exposes the log-following shell command plus a run
// counter through /api/dsh-deploy/status. The harness 0.2.1 terminal API has no
// host-side input injection: input comes from a browser attachment stream, and
// an attachment owns input EXCLUSIVELY (the newest attachment wins). So this
// plugin attaches, types Ctrl-C + the follow command, releases the stream, and
// only then opens the tab — the tab's own attachment then shows the log output.
import React from 'react'

export const name = 'dsh-server-deploy-client'
export const inject = ['slots']

// 项目主页与 GitHub mark（设置页头部图标）。
const GITHUB_REPO = 'https://github.com/max-holo/dsh-server-deploy'
const GITHUB_MARK_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z'

/** npm mark（simple-icons，currentColor 跟随主题文字色）。 */
const NPM_MARK_PATH = 'M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z'

/** 应用部署 · 设置页：标题 + npm 累计下载 + GitHub，一行说明。 */
function DeployAboutPage() {
  const [d, setD] = React.useState(null)
  // 被 DSH 官方插件详情页内嵌时（[data-plugin-config] 容器）只显示说明行。
  const rootRef = React.useRef(null)
  const [embedded, setEmbedded] = React.useState(false)
  React.useEffect(() => {
    const el = rootRef.current
    if (el !== null && el !== undefined && typeof el.closest === 'function') {
      setEmbedded(el.closest('[data-plugin-config]') !== null)
    }
    let stopped = false
    fetch('/api/dsh-deploy/downloads')
      .then((r) => r.json())
      .then((j) => { if (!stopped) setD(j) })
      .catch(() => { if (!stopped) setD({ ok: false }) })
    return () => { stopped = true }
  }, [])
  const total = d !== null && d.ok && typeof d.total === 'number' ? d.total : null
  const label = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8a8a92)' }
  return React.createElement('div', { ref: rootRef, style: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '480px', paddingBottom: '24px' } },
    React.createElement('div', { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px' } },
      React.createElement('div', { style: { fontSize: '15px', fontWeight: 600 } }, '应用部署'),
      embedded ? null : React.createElement('div', { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', marginLeft: 'auto' } },
        total !== null
          ? React.createElement('a', {
              href: 'https://www.npmjs.com/package/dsh-server-deploy',
              target: '_blank',
              rel: 'noopener noreferrer',
              title: 'npm：dsh-server-deploy · 累计下载 ' + total.toLocaleString('en-US'),
              'aria-label': '在 npm 上查看本包',
              style: { display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--dsw-alias-label-secondary, #8a8a92)', textDecoration: 'none' },
            },
            React.createElement('svg', { viewBox: '0 0 24 24', width: '13', height: '13', fill: 'currentColor', 'aria-hidden': 'true' }, React.createElement('path', { d: NPM_MARK_PATH })),
            React.createElement('span', { style: { fontSize: '12px', fontVariantNumeric: 'tabular-nums' } }, total.toLocaleString('en-US')))
          : null,
        React.createElement('a', {
          href: GITHUB_REPO,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'GitHub：max-holo/dsh-server-deploy',
          'aria-label': '在 GitHub 上查看本项目',
          style: { display: 'flex', alignItems: 'center', color: 'var(--dsw-alias-label-secondary, #8a8a92)' },
        }, React.createElement('svg', { viewBox: '0 0 16 16', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true' },
          React.createElement('path', { d: GITHUB_MARK_PATH }))),
      ),
    ),
    React.createElement('div', { style: { ...label, lineHeight: 1.6 } },
      '在会话里说「部署到 test / uat / prod」即可一键发版：构建 → 上传 → 备份 → 停启 → 健康检查。'
      + (d !== null && typeof d.version === 'string' && d.version.length > 0 ? '（当前 v' + d.version + '）' : '')),
  )
}

// terminalIds already opened in this page; survives component remounts so a
// re-rendered session never duplicates a terminal tab.
const openedTerminals = new Set()
// terminalId -> last run counter (seq) whose follow command was typed in.
const drivenSeqs = new Map()

/**
 * Attach to one terminal, type Ctrl-C + `command` + Enter, release the attachment.
 * @returns resolves true when the input was accepted (or timed out), false when
 *   the attachment could not be created (the gateway is not ready yet).
 */
function driveTerminal(terminalNamespace, sessionId, terminalId, command) {
  return new Promise((resolve) => {
    if (terminalNamespace === undefined || typeof terminalNamespace.attach !== 'function') { resolve(false); return }
    if (typeof command !== 'string' || command.length === 0) { resolve(false); return }
    const controller = new AbortController()
    let stream
    try {
      stream = terminalNamespace.attach(sessionId, terminalId, controller.signal)
    } catch (err) {
      resolve(false)
      return
    }
    if (stream === undefined || stream === null || typeof stream.send !== 'function') { resolve(false); return }

    let settled = false
    let accepted = false
    let timer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer !== null) { try { clearTimeout(timer) } catch (err) { /* ignore */ } }
      try { controller.abort() } catch (err) { /* ignore */ }
      try { if (typeof stream.dispose === 'function') stream.dispose() } catch (err) { /* ignore */ }
    }

    ;(async () => {
      try {
        for await (const frame of stream) {
          if (frame === null || typeof frame !== 'object') continue
          if (frame.type === 'snapshot') continue
          if (frame.type === 'ack') { accepted = true; break }
          if (frame.type === 'state' && frame.info !== undefined && frame.info.state !== 'running') break
        }
      } catch (err) {
        // attachment ended (terminal closed / page hidden)
      } finally {
        finish()
        resolve(accepted)
      }
    })()

    timer = setTimeout(() => { finish(); resolve(false) }, 6000)
    try {
      // Items are queued until the stream opens. Ctrl-C first: the terminal may
      // still be running the previous run's `Get-Content -Wait`, which would
      // otherwise swallow the new command into its stdin buffer.
      stream.send({ type: 'write', sequence: 1, data: '\u0003' })
      stream.send({ type: 'write', sequence: 2, data: command + '\r' })
    } catch (err) {
      finish()
      resolve(false)
    }
  })
}

export function apply(ctx) {
  // `sidebarRight` / `remote` are provided reflectively; resolve lazily so a
  // timing gap never blocks this plugin.
  function sidebarRight() {
    return ctx.get('sidebarRight')
  }
  function terminalNamespace() {
    // The generated gateway exposes the terminal namespace both as the
    // 'remote.terminal' service key and as remote.terminal; try both.
    const direct = ctx.get('remote.terminal')
    if (direct !== undefined) return direct
    const remote = ctx.get('remote')
    return remote === undefined ? undefined : remote.terminal
  }
  const openingTabs = new Set()
  function openTerminalTab(sessionId, id) {
    if (openedTerminals.has(id) || openingTabs.has(id)) return
    const sr = sidebarRight()
    if (sr === undefined) return
    openingTabs.add(id)
    // A terminal tab of the same kind merges page tabs: the arriving tab is
    // closed and the existing one focused. So a leftover deploy terminal tab
    // pointing at a dead id would swallow every new one — close our own stale
    // deploy tabs (never the user's own terminals) before opening.
    try {
      const tabs = typeof sr.openTabs?.getSnapshot === 'function' ? sr.openTabs.getSnapshot() : []
      for (const tab of tabs) {
        if (tab === null || tab === undefined || tab.sessionId !== sessionId || tab.kind !== 'terminal') continue
        let params
        try { params = sr.tabDomain.occurrence(sessionId, { id: tab.tabId }).navigation.getSnapshot().params } catch (err) { continue }
        const tabTerminal = params === null || params === undefined ? undefined : params.terminalId
        if (typeof tabTerminal === 'string' && tabTerminal.startsWith('dsh-deploy-') && tabTerminal !== id) {
          try { sr.closeIn(sessionId, tab.tabId) } catch (err) { /* already closing */ }
        }
      }
    } catch (err) {
      // layout not ready; retry on a later poll
    }
    // The tab body reads the client's cached terminal inventory and reports
    // "此终端已不存在" for an id it does not know. The cache predates the host
    // create, so refresh it before the tab mounts.
    const wt = ctx.get('webTerminals')
    const primed = wt !== undefined && typeof wt.recover === 'function'
      ? Promise.resolve(wt.recover(sessionId, true)).catch(() => undefined)
      : Promise.resolve()
    primed.then(() => {
      try {
        sr.openTabIn(sessionId, 'terminal', { params: { terminalId: id } })
        openedTerminals.add(id)
      } catch (err) {
        // terminal type not registered yet, or the tab failed to place; retry
      }
    }).finally(() => { openingTabs.delete(id) })
  }

  function DeployTerminalDriver(props) {
    const sessionId = props.sessionId

    React.useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      let stopped = false
      let pollTimer = null
      let pollIntervalMs = 15000
      let streamFailures = 0

      function applyStatus(data) {
        if (stopped || data === null || typeof data !== 'object') return
        const id = data.terminalId || (data.current && data.current.terminalId)
        const command = typeof data.followCommand === 'string' ? data.followCommand : ''
        const seq = typeof data.seq === 'number' ? data.seq : 0
        if (typeof id !== 'string' || id.length === 0) return
        if (command.length > 0 && seq > (drivenSeqs.get(id) ?? 0)) {
          // Type input while this attachment still owns it, then open the tab.
          driveTerminal(terminalNamespace(), sessionId, id, command).then((accepted) => {
            if (stopped) return
            if (accepted) {
              drivenSeqs.set(id, seq)
              openTerminalTab(sessionId, id)
            }
          })
        } else {
          openTerminalTab(sessionId, id)
        }
      }

      // Slow safety poll: catches a missed event and the no-SSE case.
      async function poll() {
        if (stopped) return
        try {
          const res = await fetch('/api/dsh-deploy/status?session=' + encodeURIComponent(sessionId))
          if (res.ok) applyStatus(await res.json())
        } catch (err) {
          // route not registered yet; retry on the next tick
        }
        if (!stopped) pollTimer = setTimeout(poll, pollIntervalMs)
      }

      let stream = null
      if (typeof EventSource === 'function') {
        try {
          stream = new EventSource('/api/dsh-deploy/events?session=' + encodeURIComponent(sessionId))
        } catch (err) {
          stream = null
        }
      }
      if (stream !== null) {
        stream.addEventListener('status', (ev) => {
          streamFailures = 0
          try { applyStatus(JSON.parse(ev.data)) } catch (err) { /* malformed event */ }
        })
        stream.addEventListener('error', () => {
          streamFailures += 1
          // 15s safety poll keeps the HUD honest; three failures fall back to 5s.
          if (streamFailures >= 3) {
            pollIntervalMs = 5000
            try { stream.close() } catch (err) { /* ignore */ }
            stream = null
          }
        })
      } else {
        pollIntervalMs = 5000
      }
      poll()

      return () => {
        stopped = true
        if (pollTimer !== null) clearTimeout(pollTimer)
        try { if (stream !== null) stream.close() } catch (err) { /* ignore */ }
        stream = null
      }
    }, [sessionId])

    return null
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-deploy-about',
    order: 11,
    label: '应用部署',
  }, DeployAboutPage))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-deploy',
    order: 10,
    label: () => '部署',
  }, DeployTerminalDriver))
}
