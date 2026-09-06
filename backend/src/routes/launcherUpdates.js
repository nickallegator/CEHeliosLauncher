'use strict'

const express = require('express')
const config = require('../config')
const { publicPolicy } = require('../services/launcherVersionPolicy')

const router = express.Router()

router.get('/launcher/update-policy', (req, res) => {
    const channel = String(req.query.channel || 'stable').trim().toLowerCase()
    const policy = config.launcherUpdates.policies.get(channel)
    if(!policy) return res.status(404).json({ error: 'launcher_update_policy_not_found', requestId: req.requestId })
    res.set('Cache-Control', 'public, max-age=300')
    res.json(publicPolicy(policy))
})

module.exports = router
