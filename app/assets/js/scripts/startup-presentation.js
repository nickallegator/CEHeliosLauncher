'use strict'

const STARTUP_INTRO_DURATION_MS = 2400
const STARTUP_SKIP_DELAY_MS = 500
const STARTUP_EXIT_DURATION_MS = 220

class StartupPresentationController {
    constructor(options = {}){
        this.document = options.document || globalThis.document
        this.matchMedia = options.matchMedia || globalThis.matchMedia?.bind(globalThis)
        this.setTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis)
        this.clearTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis)
        this.onRetry = options.onRetry || (() => {})
        this.onClose = options.onClose || (() => {})
        this.introDurationMs = options.introDurationMs ?? STARTUP_INTRO_DURATION_MS
        this.skipDelayMs = options.skipDelayMs ?? STARTUP_SKIP_DELAY_MS
        this.exitDurationMs = options.exitDurationMs ?? STARTUP_EXIT_DURATION_MS
        this.ready = false
        this.introFinished = false
        this.hidden = false
        this.reducedMotion = false
        this.stage = 'intro'
        this.pendingStage = 'distribution'
        this.timers = new Set()
    }

    start(){
        this.root = this.document?.getElementById('loadingContainer')
        if(!this.root){
            return
        }

        this.introImage = this.document.getElementById('startupIntroImage')
        this.loopImage = this.document.getElementById('startupLoopImage')
        this.staticImage = this.document.getElementById('startupStaticImage')
        this.status = this.document.getElementById('startupStatus')
        this.skipButton = this.document.getElementById('startupSkip')
        this.retryButton = this.document.getElementById('startupRetry')
        this.closeButton = this.document.getElementById('startupClose')
        this.fatalActions = this.document.getElementById('startupFatalActions')
        this.reducedMotion = this.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

        this.skipButton?.addEventListener('click', () => this.finishIntro())
        this.retryButton?.addEventListener('click', () => this.onRetry())
        this.closeButton?.addEventListener('click', () => this.onClose())
        this.document.addEventListener('keydown', this.onKeyDown = (event) => {
            if(event.key === 'Escape' && !this.introFinished && !this.hidden && !this.skipButton?.hidden){
                event.preventDefault()
                this.finishIntro()
            }
        })

        this.setStage('intro')
        if(this.skipButton) this.skipButton.hidden = true
        if(this.reducedMotion){
            this.root.setAttribute('data-reduced-motion', 'true')
            this.finishIntro()
            return
        }

        this.trackTimer(this.setTimer(() => {
            if(this.skipButton) this.skipButton.hidden = false
        }, this.skipDelayMs))
        this.trackTimer(this.setTimer(() => this.finishIntro(), this.introDurationMs))
    }

    trackTimer(timer){
        this.timers.add(timer)
        return timer
    }

    setStage(stage){
        if(!this.root || this.hidden || this.stage === 'fatal'){
            return
        }
        const allowed = new Set(['intro', 'distribution', 'account', 'ready'])
        const next = allowed.has(stage) ? stage : 'distribution'
        if(!this.introFinished && next !== 'intro'){
            this.pendingStage = next
            return
        }
        this.stage = next
        this.root.setAttribute('data-startup-state', next)
        const copy = this.status?.dataset?.[next]
        if(copy && this.status) this.status.textContent = copy
    }

    markReady(){
        this.ready = true
        if(this.introFinished){
            this.hide()
        }
    }

    finishIntro(){
        if(this.introFinished || this.hidden || !this.root){
            return
        }
        this.introFinished = true
        if(this.skipButton) this.skipButton.hidden = true
        if(this.ready){
            this.hide()
            return
        }

        const nextStage = this.pendingStage === 'ready' ? 'distribution' : this.pendingStage
        this.setStage(nextStage || 'distribution')
        this.root.setAttribute('data-startup-phase', 'loading')
        if(!this.reducedMotion && this.loopImage && !this.loopImage.getAttribute('src')){
            this.loopImage.setAttribute('src', this.loopImage.dataset.src)
        }
    }

    setFatal(title, message){
        if(!this.root || this.hidden){
            return
        }
        this.stage = 'fatal'
        this.introFinished = true
        this.root.setAttribute('data-startup-state', 'fatal')
        this.root.setAttribute('data-startup-phase', 'fatal')
        if(this.status){
            const defaultTitle = this.status.dataset.fatal || 'The launcher could not start'
            this.status.textContent = [title || defaultTitle, message].filter(Boolean).join(' — ')
        }
        if(this.skipButton) this.skipButton.hidden = true
        if(this.fatalActions) this.fatalActions.hidden = false
        if(this.loopImage) this.loopImage.removeAttribute('src')
    }

    hide(){
        if(this.hidden || !this.root){
            return
        }
        this.setStage('ready')
        this.hidden = true
        this.root.setAttribute('data-startup-phase', 'leaving')
        this.trackTimer(this.setTimer(() => {
            this.root.hidden = true
            this.root.style.display = 'none'
            if(this.loopImage) this.loopImage.removeAttribute('src')
            if(this.introImage) this.introImage.removeAttribute('src')
            this.dispose()
        }, this.reducedMotion ? 0 : this.exitDurationMs))
    }

    dispose(){
        for(const timer of this.timers) this.clearTimer(timer)
        this.timers.clear()
        if(this.onKeyDown) this.document?.removeEventListener('keydown', this.onKeyDown)
    }
}

function createStartupFacade(globalObject){
    const state = {
        controller: null,
        stage: 'intro',
        ready: false,
        fatal: null
    }
    const facade = {
        setStage(stage){
            state.stage = stage
            state.controller?.setStage(stage)
        },
        markReady(){
            state.ready = true
            state.controller?.markReady()
        },
        setFatal(title, message){
            state.fatal = { title, message }
            state.controller?.setFatal(title, message)
        },
        finishIntro(){
            state.controller?.finishIntro()
        },
        getState(){
            return state.controller?.stage || state.stage
        }
    }

    const initialize = () => {
        if(state.controller) return
        state.controller = new StartupPresentationController({
            onRetry: () => globalObject.dispatchEvent(new Event('helios:startup-retry')),
            onClose: () => globalObject.dispatchEvent(new Event('helios:startup-close'))
        })
        state.controller.start()
        if(state.fatal){
            state.controller.setFatal(state.fatal.title, state.fatal.message)
        } else {
            state.controller.setStage(state.stage)
            if(state.ready) state.controller.markReady()
        }
    }

    if(globalObject.document?.readyState === 'loading'){
        globalObject.document.addEventListener('DOMContentLoaded', initialize, { once: true })
    } else {
        initialize()
    }
    return facade
}

if(typeof window !== 'undefined'){
    window.StartupPresentation = createStartupFacade(window)
}

if(typeof module !== 'undefined'){
    module.exports = {
        STARTUP_INTRO_DURATION_MS,
        STARTUP_SKIP_DELAY_MS,
        STARTUP_EXIT_DURATION_MS,
        StartupPresentationController,
        createStartupFacade
    }
}
