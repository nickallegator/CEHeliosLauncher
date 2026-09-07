/* global ConfigManager, Lang, openModal, closeModal */
'use strict'

;(() => {
    const { ipcRenderer: updateIpc } = require('electron')
    const { LoggerUtil: UpdateLoggerUtil } = require('helios-core')
    const updateLogger = UpdateLoggerUtil.getLogger('LauncherUpdates')

    let state = null
    let initialized = false
    let modalOpen = false

    const element = id => document.getElementById(id)
    const copy = (key, placeholders) => Lang.queryJS(`updates.${key}`, placeholders)
    const preferences = () => ({ allowPrerelease: ConfigManager.getAllowPrerelease() === true })

    function formatBytes(value) {
        const bytes = Number(value)
        if(!Number.isFinite(bytes) || bytes <= 0) return copy('sizeUnknown')
        const units = ['B', 'KiB', 'MiB', 'GiB']
        let amount = bytes
        let index = 0
        while(amount >= 1024 && index < units.length - 1) {
            amount /= 1024
            index++
        }
        return `${amount.toFixed(index > 1 ? 1 : 0)} ${units[index]}`
    }

    function errorMessage(code) {
        const known = new Set(['network_unavailable', 'integrity_failed', 'cancelled', 'game_running'])
        return copy(known.has(code) ? code : 'update_failed')
    }

    function closeUpdateModal() {
        const root = element('launcherUpdateModal')
        if(typeof closeModal === 'function') closeModal(root)
        else {
            root?.removeAttribute('data-open')
            root?.setAttribute('aria-hidden', 'true')
        }
        modalOpen = false
    }

    function openUpdateModal() {
        const root = element('launcherUpdateModal')
        const panel = element('launcherUpdatePanel')
        if(!root || !panel) return
        if(typeof openModal === 'function') {
            openModal(root, panel, { onRequestClose: deferOrHide, initialFocus: '#launcherUpdatePrimary' })
        } else {
            root.setAttribute('data-open', 'true')
            root.setAttribute('aria-hidden', 'false')
            panel.focus()
        }
        modalOpen = true
        renderModal()
    }

    async function invoke(action, value) {
        try {
            const result = await updateIpc.invoke(`launcher-update:${action}`, value)
            if(result) acceptState(result)
            return result
        } catch(error) {
            const code = String(error?.code || error?.message || '').includes('game_running') ? 'game_running' : 'update_failed'
            updateLogger.warn(`Launcher update action ${action} failed.`, code)
            const alert = element('launcherUpdateError')
            if(alert) {
                alert.textContent = errorMessage(code)
                alert.hidden = false
            }
            return null
        }
    }

    async function deferOrHide() {
        if(state?.status === 'available') await invoke('defer')
        closeUpdateModal()
    }

    async function runPrimaryAction() {
        if(state?.status === 'available' || (state?.status === 'error' && state?.available)) {
            await invoke('download')
        } else if(state?.status === 'ready') {
            await invoke('install')
        } else if(state?.status === 'error' || state?.status === 'idle') {
            await invoke('check', preferences())
        }
    }

    function renderModal() {
        if(!state) return
        const available = state.available
        const title = element('launcherUpdateTitle')
        const message = element('launcherUpdateMessage')
        const version = element('launcherUpdateVersion')
        const size = element('launcherUpdateSize')
        const notes = element('launcherUpdateNotes')
        const notesSection = element('launcherUpdateNotesSection')
        const progress = element('launcherUpdateProgress')
        const progressBar = element('launcherUpdateProgressBar')
        const progressText = element('launcherUpdateProgressText')
        const error = element('launcherUpdateError')
        const primary = element('launcherUpdatePrimary')
        const later = element('launcherUpdateLater')
        if(!title || !primary) return

        version.textContent = available ? copy('versionPair', { current: state.currentVersion, next: available.version }) : copy('currentVersion', { version: state.currentVersion })
        size.textContent = available ? formatBytes(available.sizeBytes) : ''
        notes.textContent = available?.releaseNotes || copy('noReleaseNotes')
        notesSection.hidden = !available
        progress.hidden = state.status !== 'downloading' && state.status !== 'ready'
        error.hidden = state.status !== 'error'
        if(state.status === 'error') error.textContent = errorMessage(state.errorCode)

        const percent = Number(state.progress?.percent)
        if(progressBar) progressBar.style.width = `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0}%`
        if(progressText) progressText.textContent = state.status === 'ready'
            ? copy('downloadComplete')
            : copy('downloadProgress', { percent: Number.isFinite(percent) ? Math.round(percent) : 0 })

        later.textContent = state.status === 'downloading' ? copy('hide') : copy('later')
        later.hidden = state.status === 'checking'
        later.disabled = false
        primary.disabled = state.status === 'checking' || state.status === 'downloading' || (state.status === 'ready' && state.gameRunning)

        if(state.status === 'available') {
            title.textContent = copy('availableTitle')
            message.textContent = copy('availableBody')
            primary.textContent = copy('download')
        } else if(state.status === 'downloading') {
            title.textContent = copy('downloadingTitle')
            message.textContent = copy('downloadingBody')
            primary.textContent = copy('downloading')
        } else if(state.status === 'ready') {
            title.textContent = copy('readyTitle')
            message.textContent = state.gameRunning ? copy('closeMinecraft') : copy('readyBody')
            primary.textContent = copy('restart')
        } else if(state.status === 'error') {
            title.textContent = copy('errorTitle')
            message.textContent = copy('errorBody')
            primary.textContent = available ? copy('retryDownload') : copy('retryCheck')
        } else {
            title.textContent = copy('checkingTitle')
            message.textContent = copy('checkingBody')
            primary.textContent = copy('checking')
        }
    }

    function settingsAction(label, disabled, handler) {
        const button = element('settingsUpdateActionButton')
        if(!button) return
        button.textContent = label
        button.disabled = disabled
        button.onclick = handler || null
    }

    function renderSettings() {
        const title = element('settingsUpdateTitle')
        const versionValue = element('settingsUpdateVersionValue')
        const versionTitle = element('settingsUpdateVersionTitle')
        const versionCheck = element('settingsUpdateVersionCheck')
        const changelog = element('settingsTabUpdate')?.querySelector('.settingsChangelogContainer')
        const changelogTitle = changelog?.querySelector('.settingsChangelogTitle')
        const changelogText = changelog?.querySelector('.settingsChangelogText')
        const prereleaseInput = document.querySelector('input[cValue="AllowPrerelease"]')
        if(!title || !state) return

        const available = state.available
        versionValue.textContent = available?.version || state.currentVersion
        versionTitle.textContent = state.channel === 'test' ? copy('testChannel') : copy('stableChannel')
        versionTitle.style.color = state.channel === 'test' ? '#ff886d' : ''
        versionCheck.style.background = state.status === 'error' ? '#ff886d' : ''
        changelog.style.display = available ? '' : 'none'
        if(prereleaseInput) {
            prereleaseInput.checked = state.channel === 'test' || ConfigManager.getAllowPrerelease() === true
            prereleaseInput.disabled = state.channel === 'test'
        }
        if(available) {
            changelogTitle.textContent = available.releaseName
            changelogText.textContent = available.releaseNotes || copy('noReleaseNotes')
        }

        switch(state.status) {
            case 'disabled':
                title.textContent = copy('disabledTitle')
                settingsAction(copy('unavailable'), true)
                break
            case 'checking':
                title.textContent = copy('checkingTitle')
                settingsAction(copy('checking'), true)
                break
            case 'available':
                title.textContent = copy('availableTitle')
                settingsAction(copy('download'), false, openUpdateModal)
                break
            case 'downloading':
                title.textContent = copy('downloadingTitle')
                settingsAction(copy('downloadProgress', { percent: Math.round(Number(state.progress?.percent) || 0) }), true)
                break
            case 'ready':
                title.textContent = state.gameRunning ? copy('waitingForMinecraft') : copy('readyTitle')
                settingsAction(copy('restart'), state.gameRunning, openUpdateModal)
                break
            case 'error':
                title.textContent = copy('errorTitle')
                settingsAction(available ? copy('retryDownload') : copy('retryCheck'), false, openUpdateModal)
                break
            default:
                title.textContent = copy('latestTitle')
                settingsAction(copy('check'), false, () => invoke('check', preferences()))
        }
    }

    function renderNotice() {
        const notice = element('launcherUpdateNotice')
        if(!notice || !state) return
        const show = ['available', 'downloading', 'ready'].includes(state.status)
        notice.hidden = !show
        if(!show) return
        element('launcherUpdateNoticeTitle').textContent = state.status === 'ready' ? copy('noticeReady') : copy('noticeAvailable')
        element('launcherUpdateNoticeDetail').textContent = state.status === 'downloading'
            ? copy('downloadProgress', { percent: Math.round(Number(state.progress?.percent) || 0) })
            : copy('noticeVersion', { version: state.available?.version || '' })
    }

    function acceptState(next) {
        if(!next || next.schemaVersion !== 1) return
        state = next
        renderSettings()
        renderNotice()
        if(modalOpen) renderModal()
        if(window.agLauncherReady === true && state.status === 'available' && !state.dismissed && !modalOpen) openUpdateModal()
    }

    async function initialize() {
        if(initialized) return
        initialized = true
        const initial = await invoke('get-state')
        if(initial?.status !== 'disabled') await invoke('initialize', preferences())
    }

    element('launcherUpdatePrimary')?.addEventListener('click', runPrimaryAction)
    element('launcherUpdateLater')?.addEventListener('click', deferOrHide)
    element('launcherUpdateScrim')?.addEventListener('click', deferOrHide)
    element('launcherUpdateNotice')?.addEventListener('click', openUpdateModal)
    updateIpc.on('launcher-update:state-changed', (_event, next) => acceptState(next))
    window.addEventListener('ag:launcher-ready', initialize, { once: true })
    window.addEventListener('beforeunload', () => updateIpc.removeAllListeners('launcher-update:state-changed'), { once: true })

    window.LauncherUpdates = Object.freeze({
        attachSettings: renderSettings,
        getState: () => state == null ? null : JSON.parse(JSON.stringify(state)),
        setGameRunning: running => invoke('set-game-running', running),
        syncPreferences: () => invoke('check', preferences())
    })

    invoke('get-state')
    if(window.agLauncherReady === true) initialize()
})()
