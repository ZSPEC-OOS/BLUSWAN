// Child process for the kill-during-save test: rewrites one large document in a tight loop until it is killed.
import { createFileDocStore } from '../adapters/filePersistence.js'
const [dir, doc] = process.argv.slice(2)
const store = createFileDocStore({ dir })
const payload = (n) => ({ n, filler: 'x'.repeat(400_000), tail: 'END' })
console.log('ready')
for (let n = 1; ; n++) await store.put(doc, payload(n))
