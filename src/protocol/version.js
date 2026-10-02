// Versions the client and the runtime compare when they connect.
//   APP_VERSION      — the release (kept equal to package.json; a test enforces it).
//   PROTOCOL_VERSION — the HTTP/SSE contract. Bump only when an incompatible wire change ships; independent of APP_VERSION.
export const APP_VERSION = '3.0.0'
export const PROTOCOL_VERSION = 1
export const SERVICE_NAME = 'bluswan'
