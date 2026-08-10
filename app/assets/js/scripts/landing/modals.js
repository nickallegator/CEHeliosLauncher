function openModal(rootEl, panelEl){
    if(!rootEl){
        return false
    }
    rootEl.setAttribute('data-open', 'true')
    rootEl.setAttribute('aria-hidden', 'false')
    panelEl?.focus?.()
    return true
}

function closeModal(rootEl){
    if(!rootEl){
        return false
    }
    rootEl.removeAttribute('data-open')
    rootEl.setAttribute('aria-hidden', 'true')
    return true
}
