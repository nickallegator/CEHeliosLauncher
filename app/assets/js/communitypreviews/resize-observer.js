'use strict'

function calculatePreviewSize(width, height, devicePixelRatio = 1){
    const cssWidth = Math.max(1, Math.round(Number(width) || 0))
    const cssHeight = Math.max(1, Math.round(Number(height) || 0))
    const scale = Math.max(1, Math.min(2, Number(devicePixelRatio) || 1))
    return {
        cssWidth,
        cssHeight,
        pixelWidth: Math.max(1, Math.round(cssWidth * scale)),
        pixelHeight: Math.max(1, Math.round(cssHeight * scale)),
        devicePixelRatio: scale
    }
}

class CommunityPreviewResizeObserver {
    constructor(element, callback, options = {}){
        this.element = element
        this.callback = callback
        this.ResizeObserverImpl = options.ResizeObserverImpl || globalThis.ResizeObserver
        // Browser timing functions are Web IDL methods and must retain their
        // Window receiver. Keeping bound references also makes the observer
        // straightforward to replace with deterministic fakes in tests.
        this.requestFrame = options.requestFrame || globalThis.requestAnimationFrame?.bind(globalThis)
        this.cancelFrame = options.cancelFrame || globalThis.cancelAnimationFrame?.bind(globalThis)
        this.readDevicePixelRatio = options.readDevicePixelRatio || (() => globalThis.devicePixelRatio || 1)
        this.frame = null
        this.lastKey = null
        this.disconnected = false
        this.observer = null
    }

    measure(entry = null){
        const rect = entry?.contentRect || this.element?.getBoundingClientRect?.()
        if(!rect || rect.width <= 0 || rect.height <= 0) return null
        return calculatePreviewSize(rect.width, rect.height, this.readDevicePixelRatio())
    }

    schedule(entry = null){
        if(this.disconnected) return
        this.pending = entry
        if(this.frame != null) return
        const requestFrame = this.requestFrame || (callback => globalThis.setTimeout(callback, 0))
        this.frame = requestFrame(() => {
            this.frame = null
            const size = this.measure(this.pending)
            this.pending = null
            if(!size || this.disconnected) return
            const key = `${size.cssWidth}x${size.cssHeight}@${size.devicePixelRatio}`
            if(key === this.lastKey) return
            this.lastKey = key
            this.callback(size)
        })
    }

    observe(){
        if(this.disconnected || !this.element) return this
        if(this.ResizeObserverImpl){
            this.observer = new this.ResizeObserverImpl(entries => this.schedule(entries.find(entry => entry.target === this.element) || entries[0]))
            this.observer.observe(this.element)
        }
        this.schedule()
        return this
    }

    disconnect(){
        if(this.disconnected) return
        this.disconnected = true
        this.observer?.disconnect()
        this.observer = null
        if(this.frame != null){
            if(this.cancelFrame) this.cancelFrame(this.frame)
            else globalThis.clearTimeout(this.frame)
        }
        this.frame = null
        this.pending = null
    }
}

function observeCommunityPreviewSize(element, callback, options = {}){
    return new CommunityPreviewResizeObserver(element, callback, options).observe()
}

module.exports = {
    CommunityPreviewResizeObserver,
    calculatePreviewSize,
    observeCommunityPreviewSize
}
