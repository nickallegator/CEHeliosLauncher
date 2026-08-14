/* global document, window */

const modalFocusOrigins = new WeakMap()
const modalKeyHandlers = new WeakMap()

function getModalFocusable(panelEl){
    if(!panelEl) return []
    return Array.from(panelEl.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

function openModal(rootEl, panelEl, options = {}){
    if(!rootEl){
        return false
    }
    modalFocusOrigins.set(rootEl, document.activeElement)
    rootEl.setAttribute('data-open', 'true')
    rootEl.setAttribute('aria-hidden', 'false')
    const previousKeyHandler = modalKeyHandlers.get(rootEl)
    if(previousKeyHandler) document.removeEventListener('keydown', previousKeyHandler, true)
    const keyHandler = (event) => {
        if(event.key === 'Escape' && typeof options.onRequestClose === 'function'){
            event.preventDefault()
            event.stopPropagation()
            options.onRequestClose()
            return
        }
        if(event.key !== 'Tab') return
        const focusable = getModalFocusable(panelEl)
        if(focusable.length === 0){
            event.preventDefault()
            panelEl?.focus?.()
            return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if(event.shiftKey && document.activeElement === first){
            event.preventDefault()
            last.focus()
        } else if(!event.shiftKey && document.activeElement === last){
            event.preventDefault()
            first.focus()
        }
    }
    // Listen at the document boundary so Escape and focus trapping remain
    // reliable when an async renderer temporarily moves focus outside the
    // panel (for example while replacing a canvas fallback).
    document.addEventListener('keydown', keyHandler, true)
    modalKeyHandlers.set(rootEl, keyHandler)
    const initialFocus = typeof options.initialFocus === 'string'
        ? panelEl?.querySelector?.(options.initialFocus)
        : options.initialFocus
    ;(initialFocus || panelEl)?.focus?.()
    return true
}

function closeModal(rootEl){
    if(!rootEl){
        return false
    }
    rootEl.removeAttribute('data-open')
    rootEl.setAttribute('aria-hidden', 'true')
    const keyHandler = modalKeyHandlers.get(rootEl)
    if(keyHandler) document.removeEventListener('keydown', keyHandler, true)
    modalKeyHandlers.delete(rootEl)
    const origin = modalFocusOrigins.get(rootEl)
    modalFocusOrigins.delete(rootEl)
    if(origin?.isConnected) origin.focus()
    return true
}

window.openModal = openModal
window.closeModal = closeModal
