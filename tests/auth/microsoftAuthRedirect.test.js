const test = require('node:test')
const assert = require('node:assert/strict')

const {
    MICROSOFT_AUTH_REDIRECT_URI,
    parseMicrosoftAuthRedirect
} = require('../../app/assets/js/microsoftauthredirect')

test('decodes a Microsoft authorization code exactly once', () => {
    const result = parseMicrosoftAuthRedirect(
        `${MICROSOFT_AUTH_REDIRECT_URI}?code=M.C%2Bvalue%2Fpart%3D%26tail%3F&session_state=session-123`
    )

    assert.deepEqual(result, {
        code: 'M.C+value/part=&tail?',
        session_state: 'session-123'
    })
})

test('parses an OAuth error callback', () => {
    const result = parseMicrosoftAuthRedirect(
        `${MICROSOFT_AUTH_REDIRECT_URI}?error=access_denied&error_description=User%20cancelled`
    )

    assert.deepEqual(result, {
        error: 'access_denied',
        error_description: 'User cancelled'
    })
})

test('rejects malformed and lookalike callback URLs', () => {
    assert.equal(parseMicrosoftAuthRedirect('not a URL'), null)
    assert.equal(parseMicrosoftAuthRedirect(`${MICROSOFT_AUTH_REDIRECT_URI}?session_state=missing-result`), null)
    assert.equal(parseMicrosoftAuthRedirect('https://login.microsoftonline.com.evil.example/common/oauth2/nativeclient?code=test'), null)
    assert.equal(parseMicrosoftAuthRedirect('https://login.microsoftonline.com/common/oauth2/other?code=test'), null)
})
