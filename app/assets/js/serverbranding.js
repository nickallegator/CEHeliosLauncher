'use strict'

const DEFAULT_ICON = 'assets/brand/allegator-games-app-icon.png'

const PROFILE_ICONS = Object.freeze({
    'Cobble-Power-1.21.1': DEFAULT_ICON
})

/**
 * Resolve a local presentation asset for launcher-managed profiles. Keeping
 * this mapping in the client ensures older cached or remotely promoted
 * distributions cannot reintroduce superseded launcher artwork.
 *
 * @param {object} server Raw distribution server metadata.
 * @returns {string} A renderer-safe asset path or the distribution fallback.
 */
function resolveServerIcon(server){
    if(server != null && typeof server.id === 'string' && PROFILE_ICONS[server.id] != null){
        return PROFILE_ICONS[server.id]
    }
    if(server != null && typeof server.icon === 'string' && server.icon.trim() !== ''){
        return server.icon
    }
    return DEFAULT_ICON
}

module.exports = Object.freeze({
    DEFAULT_ICON,
    PROFILE_ICONS,
    resolveServerIcon
})
