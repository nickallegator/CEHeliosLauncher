const MICROSOFT_AUTH_REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient'
const microsoftAuthRedirect = new URL(MICROSOFT_AUTH_REDIRECT_URI)

/**
 * Parse a Microsoft OAuth redirect without altering encoded authorization codes.
 *
 * @param {string} uri The navigation URI received from Electron.
 * @returns {Object<string, string>|null} OAuth parameters, or null for a non-callback URI.
 */
function parseMicrosoftAuthRedirect(uri){
    let redirect
    try {
        redirect = new URL(uri)
    } catch {
        return null
    }

    if(redirect.origin !== microsoftAuthRedirect.origin
        || redirect.pathname !== microsoftAuthRedirect.pathname){
        return null
    }

    if(!redirect.searchParams.has('code') && !redirect.searchParams.has('error')){
        return null
    }

    return Object.fromEntries(redirect.searchParams.entries())
}

exports.MICROSOFT_AUTH_REDIRECT_URI = MICROSOFT_AUTH_REDIRECT_URI
exports.parseMicrosoftAuthRedirect = parseMicrosoftAuthRedirect
