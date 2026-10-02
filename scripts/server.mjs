#!/usr/bin/env node
// BLUSWAN server: runtime, provider credentials, persistence and the HTTP/SSE API. The browser talks only to this.
import { startServer, ConfigError } from '../src/server/main.js'

let running
try {
  running = await startServer({ print: (l) => console.log(l), logRequests: process.env.BLUSWAN_LOG_REQUESTS !== '0' })
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : `BLUSWAN could not start: ${e?.message ?? e}`)
  process.exit(1)
}
let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(1) // a second signal forces exit
    stopping = true
    console.log(`${sig} received: finishing up…`)
    const force = setTimeout(() => process.exit(1), 12_000); force.unref()
    running.close(sig).then(() => { console.log('BLUSWAN stopped.'); process.exit(0) }, () => process.exit(1))
  })
}
