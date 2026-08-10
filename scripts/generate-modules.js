'use strict'

const {
    main,
    usage
} = require('./lib/pack-generator')

if (require.main === module) {
    main(process.argv).catch((err) => {
        console.error(err && err.message ? err.message : err)
        process.exitCode = 1
    })
}

module.exports = {
    main,
    usage
}
