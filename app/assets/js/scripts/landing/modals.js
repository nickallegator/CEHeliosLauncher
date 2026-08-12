/* global document, window */

const modalFocusOrigins = new WeakMap()
const modalKeyHandlers = new WeakMap()

function getModalFocusable(panelEl){
    if(!panelEl) return []
    return Array.from(panelEl.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

function openModal(rootEl, panelEl){
    if(!rootEl){
        return false
    }
    modalFocusOrigins.set(rootEl, document.activeElement)
    rootEl.setAttribute('data-open', 'true')
    rootEl.setAttribute('aria-hidden', 'false')
    const keyHandler = (event) => {
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
    rootEl.addEventListener('keydown', keyHandler)
    modalKeyHandlers.set(rootEl, keyHandler)
    panelEl?.focus?.()
    return true
}

function closeModal(rootEl){
    if(!rootEl){
        return false
    }
    rootEl.removeAttribute('data-open')
    rootEl.setAttribute('aria-hidden', 'true')
    const keyHandler = modalKeyHandlers.get(rootEl)
    if(keyHandler) rootEl.removeEventListener('keydown', keyHandler)
    modalKeyHandlers.delete(rootEl)
    const origin = modalFocusOrigins.get(rootEl)
    modalFocusOrigins.delete(rootEl)
    if(origin?.isConnected) origin.focus()
    return true
}

window.openModal = openModal
window.closeModal = closeModal
