'use strict'

// Keep the existing launcher-facing names while sharing the exact evaluator
// used by Cobblemon Animation Lab and the deterministic audit CLI.
const runtime = require('cobblemon-bedrock-runtime')

function compileExpression(value) {
    try {
        return runtime.compileExpression(value)
    } catch {
        // Preserve the launcher's historical preview fallback while the
        // canonical runtime and audit CLI retain structured strict errors.
        return () => 0
    }
}

module.exports = {
    bedrockAnimationIdentity: runtime.bedrockAnimationIdentity,
    compileBedrockAnimations: runtime.compileBedrockAnimations,
    compileExpression,
    composeBedrockPoses: runtime.composeBedrockPoses,
    poserAnimationIds: runtime.poserAnimationIds,
    poserAnimationReferences: runtime.poserAnimationReferences,
    scopedBedrockAnimations: runtime.scopedBedrockAnimations,
    selectableBedrockAnimations: runtime.selectableBedrockAnimations,
    selectDefaultBedrockAnimation: runtime.selectDefaultBedrockAnimation,
    selectStaticBedrockAnimation: runtime.selectStaticBedrockAnimation,
    shortAnimationId: runtime.shortAnimationId
}
