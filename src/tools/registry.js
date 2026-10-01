// Canonical, provider-neutral tool registry.
import { readFile } from './definitions/readFile.js'
import { readManyFiles } from './definitions/readManyFiles.js'
import { listDirectory } from './definitions/listDirectory.js'
import { searchFiles } from './definitions/searchFiles.js'
import { grep } from './definitions/grep.js'
import { applyPatch } from './definitions/applyPatch.js'
import { writeFile } from './definitions/writeFile.js'
import { deleteFile } from './definitions/deleteFile.js'
import { shell } from './definitions/shell.js'
import { gitStatus } from './definitions/gitStatus.js'
import { gitDiff } from './definitions/gitDiff.js'
import { EFFECTS } from './permissions.js'

const NAME = /^[a-z][a-z0-9_]*$/

export function createToolRegistry(initial = []) {
  const tools = new Map()
  const registry = {
    registerTool(tool) {
      if (!tool || !NAME.test(tool.name ?? '')) throw new Error(`Invalid tool name: ${tool?.name}`)
      if (tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
      if (typeof tool.execute !== 'function') throw new Error(`Tool ${tool.name} has no execute()`)
      if (!tool.inputSchema || tool.inputSchema.type !== 'object') throw new Error(`Tool ${tool.name} needs an object inputSchema`)
      if (!EFFECTS.includes(tool.permission)) throw new Error(`Tool ${tool.name} has invalid permission: ${tool.permission}`)
      tools.set(tool.name, Object.freeze({ ...tool }))
      return registry
    },
    getTool: name => tools.get(name) ?? null,
    hasTool: name => tools.has(name),
    listTools: () => [...tools.values()],
    /** Provider-neutral descriptors; adapters convert these to native tool schemas. */
    describeTools: () => [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }
  initial.forEach(t => registry.registerTool(t))
  return registry
}

export const CANONICAL_TOOLS = Object.freeze([
  readFile, readManyFiles, listDirectory, searchFiles, grep, applyPatch, writeFile, deleteFile, shell, gitStatus, gitDiff,
])

export function createDefaultToolRegistry() {
  return createToolRegistry(CANONICAL_TOOLS)
}
