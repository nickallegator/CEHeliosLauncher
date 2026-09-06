'use strict'

// Compatibility surface for the launcher preview API. The canonical transform
// implementation lives in the version-pinned Cobblemon Bedrock runtime.
const runtime = require('cobblemon-bedrock-runtime')

module.exports = {
    boundsFor: runtime.boundsFor,
    composeBedrockBoneRotation: runtime.composeBedrockBoneRotation,
    parseBedrockGeometry: runtime.parseBedrockGeometry,
    selectResolverVariation: runtime.selectResolverVariation,
    transformNormal: runtime.transformNormal,
    transformPoint: runtime.transformPoint
}
