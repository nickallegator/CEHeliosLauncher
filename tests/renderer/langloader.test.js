const test = require('node:test')
const assert = require('node:assert/strict')

const langLoaderPath = require.resolve('../../app/assets/js/langloader')

function loadFreshLanguageService(){
    delete require.cache[langLoaderPath]
    return require(langLoaderPath)
}

test('language queries initialize translations before preload bootstrap completes', () => {
    const language = loadFreshLanguageService()

    assert.equal(
        language.queryJS('landing.selectedAccount.noAccountSelected'),
        'No Account Selected'
    )
})

test('language setup is idempotent and unknown keys fail safely', () => {
    const language = loadFreshLanguageService()

    language.setupLanguage()
    language.setupLanguage()

    assert.equal(language.queryJS('missing.translation.key'), '')
})
