'use strict'

/**
 * Product identity shared by the main process, renderer, and migration code.
 * Packaging metadata mirrors these values because Electron Builder reads YAML
 * before application code is available.
 */
module.exports = Object.freeze({
    productName: 'Allegator Games Launcher',
    shortName: 'AG Launcher',
    packageName: 'ag-launcher',
    appId: 'net.allegator.games.launcher',
    dataDirectoryName: '.ag-launcher',
    userDataDirectoryName: 'Allegator Games Launcher',
    legacyDataDirectoryNames: Object.freeze([
        '.cobblepower-test-launcher',
        '.helioslauncher'
    ]),
    legacyUserDataDirectoryNames: Object.freeze([
        'Cobble Power Test Launcher',
        'Helios Launcher'
    ])
})
