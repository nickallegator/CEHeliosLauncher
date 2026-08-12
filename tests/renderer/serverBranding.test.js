'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const ServerBranding = require('../../app/assets/js/serverbranding')

test('Cobble Power always uses the bundled Allegator Games profile icon', () => {
    const staleDistributionServer = {
        id: 'Cobble-Power-1.21.1',
        icon: 'https://example.invalid/legacy-helios-icon.png'
    }

    assert.equal(
        ServerBranding.resolveServerIcon(staleDistributionServer),
        'assets/brand/allegator-games-app-icon.png'
    )
})

test('unmanaged profiles preserve their configured icon with a branded fallback', () => {
    assert.equal(
        ServerBranding.resolveServerIcon({ id: 'Other-Pack', icon: 'https://example.invalid/other.png' }),
        'https://example.invalid/other.png'
    )
    assert.equal(
        ServerBranding.resolveServerIcon({ id: 'Other-Pack', icon: '' }),
        ServerBranding.DEFAULT_ICON
    )
})
