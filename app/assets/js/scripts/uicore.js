/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $                              = require('jquery')
const {ipcRenderer, shell, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')

// Log deprecation and process warnings.
process.traceProcessWarnings = true
process.traceDeprecation = true

function reportRendererError(kind, error) {
    try {
        const payload = {
            kind,
            message: error?.message || String(error),
            stack: error?.stack || null
        }
        console.error('[RendererError]', payload)
        ipcRenderer.send('rendererError', payload)
    } catch (err) {
        console.error('[RendererError] failed to report', err)
    }
}

window.addEventListener('error', (event) => {
    reportRendererError('error', event?.error || event?.message)
})

window.addEventListener('unhandledrejection', (event) => {
    reportRendererError('unhandledrejection', event?.reason)
})

process.on('uncaughtException', (err) => {
    reportRendererError('uncaughtException', err)
})

process.on('unhandledRejection', (reason) => {
    reportRendererError('unhandledRejection', reason)
})

// Disable eval function.
window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on('devtools-opened', () => {
    console.log('%cThe console is dark and full of terrors.', 'color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold')
    console.log('%cIf you\'ve been told to paste something here, you\'re being scammed.', 'font-size: 16px')
    console.log('%cUnless you know exactly what you\'re doing, close this window.', 'font-size: 16px')
})

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

let interactiveUIInitialized = false
let completeUIInitialized = false

function initInteractiveUI(){
    if(interactiveUIInitialized){
        return
    }
    interactiveUIInitialized = true

    loggerUICore.info('UICore Initializing..')

    // Bind close button.
    Array.from(document.getElementsByClassName('fCb')).map((val) => {
        val.addEventListener('click', () => {
            const window = remote.getCurrentWindow()
            window.close()
        })
    })

    // Bind restore down button.
    Array.from(document.getElementsByClassName('fRb')).map((val) => {
        val.addEventListener('click', () => {
            const window = remote.getCurrentWindow()
            if(window.isMaximized()){
                window.unmaximize()
            } else {
                window.maximize()
            }
            document.activeElement.blur()
        })
    })

    // Bind minimize button.
    Array.from(document.getElementsByClassName('fMb')).map((val) => {
        val.addEventListener('click', () => {
            const window = remote.getCurrentWindow()
            window.minimize()
            document.activeElement.blur()
        })
    })

    // Remove focus from social media buttons once they're clicked.
    Array.from(document.getElementsByClassName('mediaURL')).map(val => {
        val.addEventListener('click', () => {
            document.activeElement.blur()
        })
    })
}

function initCompleteUI(){
    if(completeUIInitialized){
        return
    }
    completeUIInitialized = true

    document.body.setAttribute('data-renderer-ready', 'true')
}

function handleReadyState(){
    if(document.readyState === 'interactive' || document.readyState === 'complete'){
        initInteractiveUI()
    }
    if(document.readyState === 'complete'){
        initCompleteUI()
    }
}

document.addEventListener('readystatechange', handleReadyState, false)
handleReadyState()

/**
 * Open web links in the user's default browser.
 */
$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    shell.openExternal(this.href)
})

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code. 
 */
document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})
