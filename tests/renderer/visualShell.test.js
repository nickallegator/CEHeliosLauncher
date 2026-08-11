'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ejs = require('ejs')

const {
    StartupPresentationController,
    STARTUP_INTRO_DURATION_MS,
    STARTUP_SKIP_DELAY_MS
} = require('../../app/assets/js/scripts/startup-presentation')
const {
    CommunityModuleRegistry,
    createDefaultCommunityRegistry,
    isSchematicsEnabled
} = require('../../app/assets/js/scripts/community-modules')
const { countOptionalModules } = require('../../app/assets/js/scripts/shell')
const { checkRendererAssets } = require('../../scripts/check-renderer-assets')

class FakeElement extends EventTarget {
    constructor(dataset = {}){
        super()
        this.dataset = dataset
        this.attributes = new Map()
        this.hidden = false
        this.style = {}
        this.textContent = ''
    }
    setAttribute(name, value){ this.attributes.set(name, String(value)) }
    getAttribute(name){ return this.attributes.get(name) ?? null }
    removeAttribute(name){ this.attributes.delete(name) }
}

class FakeDocument extends EventTarget {
    constructor(){
        super()
        this.elements = new Map([
            ['loadingContainer', new FakeElement()],
            ['startupIntroImage', new FakeElement()],
            ['startupLoopImage', new FakeElement({ src: 'assets/brand/allegator-games-loading-chomp.svg' })],
            ['startupStaticImage', new FakeElement()],
            ['startupStatus', new FakeElement({ intro: 'Intro', distribution: 'Distribution', account: 'Account', ready: 'Ready', fatal: 'Fatal' })],
            ['startupSkip', new FakeElement()],
            ['startupRetry', new FakeElement()],
            ['startupClose', new FakeElement()],
            ['startupFatalActions', new FakeElement()]
        ])
    }
    getElementById(id){ return this.elements.get(id) || null }
}

function createTimers(){
    const timers = []
    return {
        timers,
        setTimeout(callback, delay){
            const timer = { callback, delay, cleared: false }
            timers.push(timer)
            return timer
        },
        clearTimeout(timer){ timer.cleared = true },
        run(delay){
            timers.filter((timer) => !timer.cleared && timer.delay <= delay).forEach((timer) => {
                timer.cleared = true
                timer.callback()
            })
        }
    }
}

function createStartup(options = {}){
    const document = new FakeDocument()
    const timers = createTimers()
    const controller = new StartupPresentationController({
        document,
        matchMedia: () => ({ matches: options.reducedMotion === true }),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        introDurationMs: STARTUP_INTRO_DURATION_MS,
        skipDelayMs: STARTUP_SKIP_DELAY_MS,
        exitDurationMs: 1
    })
    controller.start()
    return { controller, document, timers }
}

test('startup intro is finite, delayed-skippable, and hands off to the loading loop', () => {
    const { controller, document, timers } = createStartup()
    const skip = document.getElementById('startupSkip')
    assert.equal(skip.hidden, true)
    timers.run(STARTUP_SKIP_DELAY_MS)
    assert.equal(skip.hidden, false)
    controller.setStage('account')
    assert.equal(document.getElementById('startupStatus').textContent, 'Intro')
    controller.finishIntro()
    assert.equal(controller.stage, 'account')
    assert.equal(document.getElementById('loadingContainer').getAttribute('data-startup-phase'), 'loading')
    assert.equal(document.getElementById('startupLoopImage').getAttribute('src'), 'assets/brand/allegator-games-loading-chomp.svg')
})

test('startup waits for the intro before revealing an already-ready UI', () => {
    const { controller, document, timers } = createStartup()
    controller.markReady()
    assert.equal(controller.stage, 'intro')
    assert.equal(document.getElementById('loadingContainer').hidden, false)
    controller.finishIntro()
    timers.run(1)
    assert.equal(document.getElementById('loadingContainer').hidden, true)
    assert.equal(document.getElementById('startupLoopImage').getAttribute('src'), null)
})

test('reduced motion bypasses animated startup assets', () => {
    const { controller, document } = createStartup({ reducedMotion: true })
    assert.equal(controller.introFinished, true)
    assert.equal(document.getElementById('loadingContainer').getAttribute('data-reduced-motion'), 'true')
    assert.equal(document.getElementById('startupLoopImage').getAttribute('src'), null)
})

test('fatal startup stops the loop and exposes recovery actions', () => {
    const { controller, document } = createStartup()
    controller.finishIntro()
    controller.setFatal('Distribution unavailable', 'Try again later')
    assert.equal(controller.stage, 'fatal')
    assert.equal(document.getElementById('startupLoopImage').getAttribute('src'), null)
    assert.equal(document.getElementById('startupFatalActions').hidden, false)
    assert.match(document.getElementById('startupStatus').textContent, /Distribution unavailable/)
})

test('community registry validates ids and filters disabled modules', async () => {
    const registry = new CommunityModuleRegistry()
    registry.register({ id: 'enabled', isEnabled: async () => true, open(){} })
    registry.register({ id: 'disabled', isEnabled: async () => false, open(){} })
    assert.deepEqual((await registry.enabled()).map((module) => module.id), ['enabled'])
    assert.throws(() => registry.register({ id: 'enabled', isEnabled(){ return true }, open(){} }), /Duplicate/)
})

test('schematics module follows existing distribution and environment capabilities', async () => {
    assert.equal(isSchematicsEnabled({ schematics: { schemaVersion: 2, enabled: true, features: { core: true } } }), true)
    assert.equal(isSchematicsEnabled({ schematics: { schemaVersion: 3, enabled: true } }), false)
    assert.equal(isSchematicsEnabled({}, { HELIOS_SCHEMATICS_API_URL: 'https://schematics.example.test' }), true)
    const registry = createDefaultCommunityRegistry({ environment: {} })
    assert.equal((await registry.enabled({ rawDistribution: {} })).length, 0)
})

test('Home optional-module summary includes nested optional modules', () => {
    const required = { getRequired: () => ({ value: true }), subModules: [] }
    const optional = { getRequired: () => ({ value: false }), subModules: [required] }
    const nested = { getRequired: () => ({ value: true }), subModules: [optional] }
    assert.equal(countOptionalModules([optional, nested]), 2)
})

test('renderer template contains the brand sequence and persistent navigation', async () => {
    const appPath = path.resolve(__dirname, '..', '..', 'app', 'app.ejs')
    const html = await ejs.renderFile(appPath, { lang: (key) => key })
    assert.match(html, /allegator-games-intro\.svg/)
    assert.match(html, /allegator-games-loading-chomp\.svg/)
    assert.match(html, /id="shellNavCommunity"/)
    assert.match(html, /id="appShellViewport"/)
})

test('renderer artwork remains inside the vector-first asset budget', () => {
    assert.deepEqual(checkRendererAssets().failures, [])
})

test('main window declares the responsive default and minimum bounds', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.js'), 'utf8')
    assert.match(source, /width:\s*1180/)
    assert.match(source, /height:\s*680/)
    assert.match(source, /minWidth:\s*980/)
    assert.match(source, /minHeight:\s*600/)
})
