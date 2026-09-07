'use strict'

class ServerStatusManager {
    constructor(options = {}) {
        this.fetchStatus = options.fetchStatus
        this.onUpdate = options.onUpdate || (() => {})
        this.now = options.now || (() => Date.now())
        this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay))
        this.clearTimer = options.clearTimer || (timer => clearTimeout(timer))
        this.server = null
        this.active = false
        this.timer = null
        this.controller = null
        this.generation = 0
        this.failures = 0
        this.lastSuccess = null
    }

    select(server) {
        this.stopRequest()
        this.server = server || null
        this.failures = 0
        this.lastSuccess = null
        if(this.active && this.server) this.refresh()
    }

    setActive(active) {
        const next = Boolean(active)
        if(this.active === next) return
        this.active = next
        if(!this.active) {
            this.stopRequest()
            return
        }
        if(this.server) this.refresh()
    }

    stopRequest() {
        this.generation++
        if(this.timer) this.clearTimer(this.timer)
        this.timer = null
        this.controller?.abort()
        this.controller = null
    }

    schedule(seconds) {
        if(!this.active || !this.server) return
        if(this.timer) this.clearTimer(this.timer)
        this.timer = this.setTimer(() => this.refresh(), seconds * 1000)
    }

    async refresh() {
        if(!this.active || !this.server || this.controller) return
        const generation = ++this.generation
        this.controller = new AbortController()
        this.onUpdate({ state: 'checking', lastSuccess: this.lastSuccess })
        try {
            const result = await this.fetchStatus(this.server, this.controller.signal)
            if(generation !== this.generation) return
            this.failures = result.state === 'unknown' ? this.failures + 1 : 0
            if(result.state === 'online') this.lastSuccess = result
            this.onUpdate(result)
        } catch(err) {
            if(err?.name === 'AbortError' || generation !== this.generation) return
            this.failures++
            const age = this.lastSuccess ? this.now() - Date.parse(this.lastSuccess.checkedAt) : Infinity
            this.onUpdate(age <= 60_000
                ? { ...this.lastSuccess, stale: true }
                : { state: 'unknown', stale: false, checkedAt: new Date(this.now()).toISOString() })
        } finally {
            if(generation === this.generation) {
                this.controller = null
                const base = this.server?.refreshSeconds || 30
                this.schedule(this.failures === 0 ? base : (this.failures === 1 ? 60 : 120))
            }
        }
    }

    destroy() {
        this.active = false
        this.server = null
        this.stopRequest()
    }
}

module.exports = { ServerStatusManager }
