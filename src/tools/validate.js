// Minimal JSON-Schema-subset validator for tool inputs: type, required,
// properties, additionalProperties:false, enum, minimum/maximum, minLength,
// items, minItems/maxItems. Enough for canonical tool schemas; no dependencies.

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string'
    case 'integer': return Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v)
    default: return true
  }
}

function check(schema, value, at, errors) {
  if (schema.type && !typeOk(schema.type, value)) { errors.push(`${at} must be of type ${schema.type}`); return }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of: ${schema.enum.join(', ')}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`)
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${at} must not be shorter than ${schema.minLength} characters`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at} must contain at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at} must contain at most ${schema.maxItems} items`)
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${at}[${i}]`, errors))
  }
  if (schema.type === 'object' && typeOk('object', value)) {
    for (const key of schema.required ?? []) if (!(key in value) || value[key] === undefined) errors.push(`${at}.${key} is required`)
    const props = schema.properties ?? {}
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue
      if (props[key]) check(props[key], v, `${at}.${key}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not an allowed property`)
    }
  }
}

/** @returns {{ok:boolean, errors:string[]}} */
export function validateInput(schema, input) {
  const errors = []
  check(schema, input ?? {}, 'input', errors)
  return { ok: errors.length === 0, errors }
}
