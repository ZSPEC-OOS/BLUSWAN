#!/usr/bin/env node
// npm run doctor [-- --url https://bluswan.example.com] [--live] [--json]
import { execFile } from 'node:child_process'
import { runDoctor, formatDoctor } from '../src/server/doctor.js'

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const value = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }

const runLive = (provider) => new Promise((resolve) => {
  execFile(process.execPath, ['--env-file-if-exists=.env', 'scripts/provider-smoke.mjs', provider], { timeout: 120_000 }, (err, stdout, stderr) => {
    resolve({ ok: !err, detail: err ? String(stderr || stdout).split('\n').filter(Boolean).slice(-1)[0] : '' })
  })
})

const result = await runDoctor({ url: value('url'), live: flag('live'), runLive })
console.log(flag('json') ? JSON.stringify(result, null, 2) : formatDoctor(result))
process.exit(result.ok ? 0 : 1)
