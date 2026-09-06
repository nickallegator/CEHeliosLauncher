'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('update UI renders provider metadata as text and uses typed IPC only', () => {
    const controller = read('app/assets/js/scripts/launcher-updates.js')
    assert.match(controller, /notes\.textContent =/)
    assert.doesNotMatch(controller, /notes\.innerHTML/)
    assert.match(controller, /launcher-update:\$\{action\}/)
    for(const action of ['get-state', 'initialize', 'check', 'download', 'install']) {
        assert.match(controller, new RegExp(`invoke\\('${action}'`))
    }
    assert.doesNotMatch(controller, /autoUpdater/)
})

test('packaging enables updates only for supported authenticated Windows builds', () => {
    const main = read('index.js')
    assert.match(main, /app\.isPackaged/)
    assert.match(main, /process\.platform === 'win32'/)
    assert.match(main, /AG_COMMUNITY_SHOWROOM/)
    assert.match(main, /packagedChannel\.schemaVersion === 2/)
    assert.doesNotMatch(main, /autoUpdateAction/)
})

test('branded update prompt has accessible dialog and live progress semantics', () => {
    const markup = read('app/partials/update.ejs')
    assert.match(markup, /role="dialog"/)
    assert.match(markup, /aria-modal="true"/)
    assert.match(markup, /aria-live="polite"/)
    assert.match(markup, /launcherUpdatePrimary/)
    assert.match(markup, /launcherUpdateLater/)
})
