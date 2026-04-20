/**
 * Connector Registry — describes the different kinds of physical / logical
 * connections between components.
 *
 * Each descriptor pairs a connector TYPE with visual style, validation rules
 * and (eventually) snap behaviour.
 */

const registry = new Map()

function register(descriptor) {
  registry.set(descriptor.type, descriptor)
}

// ---------------------------------------------------------------------------
// Connector types
// ---------------------------------------------------------------------------

register({
  type: 'socket',
  name: 'CPU Socket',
  description: 'Zero-insertion-force socket that seats the CPU onto the motherboard.',
  color: '#f59e0b',
  slotType: 'cpu_socket',
  lineStyle: 'solid',
  validPairs: [['cpu', 'motherboard']],
})

register({
  type: 'dimm',
  name: 'DIMM Channel',
  description: 'Memory channel connecting a RAM stick to a DIMM slot.',
  color: '#06b6d4',
  slotType: 'dimm',
  lineStyle: 'solid',
  validPairs: [['ram', 'motherboard']],
})

register({
  type: 'pcie',
  name: 'PCIe Link',
  description: 'High-speed PCIe x16 lane connecting expansion cards to the chipset.',
  color: '#8b5cf6',
  slotType: 'pcie_x16',
  lineStyle: 'solid',
  validPairs: [['gpu', 'motherboard']],
})

register({
  type: 'nvme',
  name: 'NVMe / M.2',
  description: 'M.2 connector carrying NVMe protocol for solid-state storage.',
  color: '#ec4899',
  slotType: 'm2',
  lineStyle: 'dashed',
  validPairs: [['ssd', 'motherboard']],
})

register({
  type: 'atx_power',
  name: 'ATX 24-pin Power',
  description: 'Main power rail from the PSU to the motherboard.',
  color: '#ef4444',
  slotType: 'atx_24pin',
  lineStyle: 'solid',
  validPairs: [['psu', 'motherboard']],
})

register({
  type: 'cooler_mount',
  name: 'Cooler Mount',
  description: 'Thermal interface mount attaching a cooler to the CPU.',
  color: '#22d3ee',
  slotType: 'cooler_mount',
  lineStyle: 'dashed',
  validPairs: [['cooler', 'cpu']],
})

register({
  type: 'mobo_standoff',
  name: 'Standoff Mount',
  description: 'Standoff screws securing the motherboard inside the chassis.',
  color: '#a3a3a3',
  slotType: 'mobo_standoff',
  lineStyle: 'solid',
  validPairs: [['motherboard', 'case']],
})

register({
  type: 'psu_bay',
  name: 'PSU Bay',
  description: 'Physical bay in the chassis that houses the power supply.',
  color: '#a3a3a3',
  slotType: 'psu_bay',
  lineStyle: 'solid',
  validPairs: [['psu', 'case']],
})

register({
  type: 'data_bus',
  name: 'Data Bus',
  description: 'Generic high-speed data interconnect.',
  color: '#6366f1',
  slotType: null,
  lineStyle: 'solid',
  validPairs: [],
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const connectorRegistry = registry

export function getConnector(type) {
  return registry.get(type)
}

export function allConnectors() {
  return [...registry.values()]
}

/**
 * Returns all connector types that are valid between two component types,
 * regardless of direction.
 */
export function validConnectorsBetween(typeA, typeB) {
  return allConnectors().filter((c) =>
    c.validPairs.some(
      ([a, b]) => (a === typeA && b === typeB) || (a === typeB && b === typeA),
    ),
  )
}

/**
 * Determine the best connector type to auto-assign when the user draws a
 * connection between two placed components.
 */
export function inferConnectorType(fromComponentType, toComponentType) {
  const candidates = validConnectorsBetween(fromComponentType, toComponentType)
  return candidates.length > 0 ? candidates[0].type : 'data_bus'
}
