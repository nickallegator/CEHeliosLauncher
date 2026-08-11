const fs = require('fs-extra')
const path = require('path')
const toml = require('toml')
const merge = require('lodash.merge')

let lang
let initialized = false

exports.loadLanguage = function(id){
    lang = merge(lang || {}, toml.parse(fs.readFileSync(path.join(__dirname, '..', 'lang', `${id}.toml`))) || {})
}

exports.query = function(id, placeHolders){
    // Renderer page scripts can run while the asynchronous preload bootstrap is
    // still restoring the remote tester channel. Keep localization independent
    // from that work so an early UI query cannot crash the entire startup.
    exports.setupLanguage()

    let query = id.split('.')
    let res = lang
    for(let q of query){
        if(res == null || typeof res !== 'object' || !Object.prototype.hasOwnProperty.call(res, q)){
            return ''
        }
        res = res[q]
    }
    let text = res === lang ? '' : res
    if (placeHolders && typeof text === 'string') {
        Object.entries(placeHolders).forEach(([key, value]) => {
            text = text.replace(`{${key}}`, value)
        })
    }
    return text
}

exports.queryJS = function(id, placeHolders){
    return exports.query(`js.${id}`, placeHolders)
}

exports.queryEJS = function(id, placeHolders){
    return exports.query(`ejs.${id}`, placeHolders)
}

exports.setupLanguage = function(){
    if(initialized){
        return
    }

    // Load Language Files
    exports.loadLanguage('en_US')
    // Uncomment this when translations are ready
    //exports.loadLanguage('xx_XX')

    // Load Custom Language File for Launcher Customizer
    exports.loadLanguage('_custom')
    initialized = true
}
