'use strict'

const packageMetadata = require('../../../package.json')
const semver = require('semver')

function getLauncherChannel(version = packageMetadata.version) {
    const prerelease = semver.prerelease(version)
    return Array.isArray(prerelease) && String(prerelease[0]).toLowerCase() === 'test'
        ? 'test'
        : 'stable'
}

function getLauncherRequestHeaders() {
    return {
        'X-AG-Launcher-Version': packageMetadata.version,
        'X-AG-Launcher-Channel': getLauncherChannel()
    }
}

module.exports = { getLauncherChannel, getLauncherRequestHeaders }
