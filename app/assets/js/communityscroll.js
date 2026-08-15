'use strict'

/**
 * Capture a scroll container's current offset before replacing its children.
 * Calling the returned function restores that offset after the synchronous DOM
 * update. Browsers clamp offsets automatically if the new content is shorter.
 */
function captureScrollPosition(element, options = {}) {
    const scrollTop = options.reset ? 0 : Math.max(0, Number(element?.scrollTop) || 0)
    const scrollLeft = options.reset ? 0 : Math.max(0, Number(element?.scrollLeft) || 0)
    return () => {
        if(!element) return
        element.scrollTop = scrollTop
        element.scrollLeft = scrollLeft
    }
}

module.exports = { captureScrollPosition }
