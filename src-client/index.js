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

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-deploy',
    order: 10,
    label: () => '部署',
  }, DeployTerminalDriver))
}
