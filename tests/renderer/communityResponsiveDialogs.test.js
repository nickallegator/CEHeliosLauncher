'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { AutomationCommunityPreview } = require('../../app/assets/js/communitypreviews/automation')
const {
    CommunityPreviewResizeObserver,
    calculatePreviewSize
} = require('../../app/assets/js/communitypreviews/resize-observer')
const { screenToWorld } = require('../../libraries/community-rendering')

const root = path.resolve(__dirname, '..', '..')

test('responsive preview sizes cap device density and never produce empty backing stores', () => {
    assert.deepEqual(calculatePreviewSize(640.4, 359.6, 1.5), {
        cssWidth: 640,
        cssHeight: 360,
        pixelWidth: 960,
        pixelHeight: 540,
        devicePixelRatio: 1.5
    })
    assert.deepEqual(calculatePreviewSize(0, 0, 4), {
        cssWidth: 1,
        cssHeight: 1,
        pixelWidth: 2,
        pixelHeight: 2,
        devicePixelRatio: 2
    })
})

test('resize observations coalesce frames, suppress duplicates, and stop after disconnect', () => {
    const frames = []
    const callbacks = []
    const element = { getBoundingClientRect: () => ({ width: 400, height: 240 }) }
    const observer = new CommunityPreviewResizeObserver(element, size => callbacks.push(size), {
        ResizeObserverImpl: null,
        requestFrame: callback => { frames.push(callback); return frames.length },
        cancelFrame: () => {},
        readDevicePixelRatio: () => 1.25
    })
    observer.observe()
    observer.schedule()
    assert.equal(frames.length, 1)
    frames.shift()()
    assert.equal(callbacks.length, 1)
    observer.schedule()
    frames.shift()()
    assert.equal(callbacks.length, 1)
    observer.disconnect()
    observer.schedule()
    assert.equal(frames.length, 0)
})

test('Automation pointer coordinates and camera centre remain stable across canvas resizing', () => {
    const preview = Object.create(AutomationCommunityPreview.prototype)
    preview.destroyed = false
    preview.hasMeasuredSize = true
    preview.camera = { panX: 20, panY: 30, zoom: 1.5 }
    preview.canvas = {
        width: 800,
        height: 480,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 240 })
    }
    preview.render = () => {}
    assert.deepEqual(preview.eventPoint({ clientX: 210, clientY: 140 }), { x: 400, y: 240, scale: 2 })
    const before = screenToWorld(preview.camera, preview.canvas.width / 2, preview.canvas.height / 2)
    preview.resize({ devicePixelRatio: 1 })
    const after = screenToWorld(preview.camera, preview.canvas.width / 2, preview.canvas.height / 2)
    assert.deepEqual(after, before)
    assert.equal(preview.canvas.width, 400)
    assert.equal(preview.canvas.height, 240)
})

test('Community detail and publishing templates use the shared semantic dialog shell', () => {
    const detail = fs.readFileSync(path.join(root, 'app', 'partials', 'landing', 'community', 'modals', 'content-detail.ejs'), 'utf8')
    const schematic = fs.readFileSync(path.join(root, 'app', 'partials', 'landing', 'community', 'modals', 'detail.ejs'), 'utf8')
    const publish = fs.readFileSync(path.join(root, 'app', 'partials', 'landing', 'community', 'modals', 'content-publish.ejs'), 'utf8')
    for(const template of [detail, schematic, publish]) {
        assert.match(template, /communityDialogPanel/)
        assert.match(template, /<header[^>]+communityDialogHeader/)
        assert.match(template, /<main[^>]+communityDialogMain/)
        assert.match(template, /<footer[^>]+communityDialogFooter/)
    }
    assert.match(detail, /<aside[^>]+communityContentDetailCopy/)
    assert.match(schematic, /<aside id="schematicsDetailInfo"/)
    assert.match(publish, /communityContentPublishSource/)
    assert.match(publish, /communityContentPublishMetadata/)
})

test('Community dialog CSS defines fluid wide, compact, and container-responsive layouts', () => {
    const css = fs.readFileSync(path.join(root, 'app', 'assets', 'css', 'overhaul', 'community.css'), 'utf8')
    assert.match(css, /width:\s*min\(1440px, calc\(100vw - 32px\)\)/)
    assert.match(css, /@media \(max-width: 1099px\), \(max-height: 639px\)/)
    assert.match(css, /@container community-preview \(max-width: 700px\)/)
    assert.match(css, /backdrop-filter:\s*none/)
})

test('modal controller supports Escape dismissal and initial focus without changing legacy callers', () => {
    const source = fs.readFileSync(path.join(root, 'app', 'assets', 'js', 'scripts', 'landing', 'modals.js'), 'utf8')
    assert.match(source, /function openModal\(rootEl, panelEl, options = \{\}\)/)
    assert.match(source, /event\.key === 'Escape'/)
    assert.match(source, /options\.onRequestClose/)
    assert.match(source, /options\.initialFocus/)
})
