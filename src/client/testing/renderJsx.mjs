// Registers the JSX loader once and renders React elements to static HTML for assertions.
import { register } from 'node:module'

register('./jsxLoader.mjs', import.meta.url)

export async function importComponent(relativeToClient) {
  return import(new URL(`../${relativeToClient}`, import.meta.url).href)
}

export async function render(element) {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup(element)
}

export const h = async (Component, props = {}) => (await import('react')).createElement(Component, props)
