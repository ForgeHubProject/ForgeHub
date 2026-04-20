/**
 * Component Registry — the "package catalog" for ForgeHub.
 *
 * Each descriptor defines a component TYPE (not instance). Instances live in
 * the Zustand store as plain JSON; the registry supplies behaviour, specs,
 * mount-point definitions and search metadata.
 */

const registry = new Map()

function register(descriptor) {
  registry.set(descriptor.type, descriptor)
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

register({
  type: 'cpu',
  name: 'CPU Module',
  category: 'Processing',
  description:
    'Central processing unit — the core that executes instructions. Sits in a socket on the motherboard.',
  tags: ['processor', 'compute', 'core', 'chip', 'socket', 'lga'],
  specs: {
    socket: 'LGA1700',
    pins: 1700,
    voltage: '1.8 V',
    tdp: '125 W',
    cores: 8,
  },
  mountPoints: [
    { id: 'cooler_top', slotType: 'cooler_mount', label: 'Cooler mount', localPosition: { x: 0, y: 0.4, z: 0 } },
  ],
  fitsInSlots: ['cpu_socket'],
  model: 'cpu',
})

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

register({
  type: 'ram',
  name: 'RAM Stick',
  category: 'Memory',
  description:
    'DDR5 memory module. Slots into DIMM channels on the motherboard for fast volatile storage.',
  tags: ['memory', 'dimm', 'ddr5', 'volatile', 'stick'],
  specs: {
    capacity: '16 GB',
    speed: '3200 MHz',
    type: 'DDR5',
    voltage: '1.1 V',
    formFactor: 'DIMM',
  },
  mountPoints: [],
  fitsInSlots: ['dimm'],
  model: 'ram',
})

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

register({
  type: 'motherboard',
  name: 'Motherboard',
  category: 'Board',
  description:
    'Main circuit board that interconnects all components. Provides CPU socket, DIMM slots, PCIe lanes and power delivery.',
  tags: ['board', 'pcb', 'atx', 'mainboard', 'mobo'],
  specs: {
    formFactor: 'ATX',
    cpuSocket: 'LGA1700',
    dimmSlots: 4,
    pcieX16: 2,
    m2Slots: 2,
    chipset: 'Z790',
  },
  mountPoints: [
    { id: 'cpu_socket', slotType: 'cpu_socket', label: 'CPU Socket', localPosition: { x: -0.5, y: 0.11, z: -0.3 } },
    { id: 'dimm_0', slotType: 'dimm', label: 'DIMM Slot 1', localPosition: { x: 0.9, y: 0.12, z: -0.6 } },
    { id: 'dimm_1', slotType: 'dimm', label: 'DIMM Slot 2', localPosition: { x: 0.9, y: 0.12, z: -0.45 } },
    { id: 'dimm_2', slotType: 'dimm', label: 'DIMM Slot 3', localPosition: { x: 0.9, y: 0.12, z: -0.3 } },
    { id: 'dimm_3', slotType: 'dimm', label: 'DIMM Slot 4', localPosition: { x: 0.9, y: 0.12, z: -0.15 } },
    { id: 'pcie_0', slotType: 'pcie_x16', label: 'PCIe x16 Slot 1', localPosition: { x: -0.2, y: 0.12, z: 0.4 } },
    { id: 'pcie_1', slotType: 'pcie_x16', label: 'PCIe x16 Slot 2', localPosition: { x: -0.2, y: 0.12, z: 0.7 } },
    { id: 'm2_0', slotType: 'm2', label: 'M.2 Slot 1', localPosition: { x: 0.4, y: 0.11, z: 0.2 } },
    { id: 'm2_1', slotType: 'm2', label: 'M.2 Slot 2', localPosition: { x: 0.4, y: 0.11, z: 0.5 } },
    { id: 'atx_power', slotType: 'atx_24pin', label: '24-pin ATX Power', localPosition: { x: 1.3, y: 0.12, z: -0.2 } },
  ],
  fitsInSlots: ['mobo_standoff'],
  model: 'motherboard',
})

// ---------------------------------------------------------------------------
// Graphics
// ---------------------------------------------------------------------------

register({
  type: 'gpu',
  name: 'Graphics Card',
  category: 'Graphics',
  description:
    'Discrete GPU for rendering and parallel compute. Occupies a PCIe x16 slot and often requires dedicated power.',
  tags: ['graphics', 'gpu', 'video', 'render', 'pcie', 'cuda', 'display'],
  specs: {
    vram: '12 GB GDDR6X',
    tdp: '300 W',
    interface: 'PCIe 5.0 x16',
    outputs: 'HDMI 2.1, 3× DP 1.4a',
    length: '320 mm',
  },
  mountPoints: [],
  fitsInSlots: ['pcie_x16'],
  model: 'gpu',
})

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

register({
  type: 'ssd',
  name: 'NVMe SSD',
  category: 'Storage',
  description:
    'M.2 NVMe solid-state drive for high-speed persistent storage. Connects via the M.2 slot on the motherboard.',
  tags: ['storage', 'nvme', 'ssd', 'm2', 'flash', 'drive', 'disk'],
  specs: {
    capacity: '1 TB',
    interface: 'PCIe 4.0 x4 NVMe',
    seqRead: '7000 MB/s',
    seqWrite: '5000 MB/s',
    formFactor: 'M.2 2280',
  },
  mountPoints: [],
  fitsInSlots: ['m2'],
  model: 'ssd',
})

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

register({
  type: 'psu',
  name: 'Power Supply',
  category: 'Power',
  description:
    'ATX power supply unit. Converts mains AC to regulated DC rails and feeds all other components.',
  tags: ['power', 'psu', 'supply', 'atx', 'watt', 'modular'],
  specs: {
    wattage: '850 W',
    efficiency: '80+ Gold',
    modular: 'Fully modular',
    fanSize: '120 mm',
    rails: '+12 V, +5 V, +3.3 V',
  },
  mountPoints: [
    { id: 'atx_24pin_out', slotType: 'atx_24pin', label: '24-pin ATX out', localPosition: { x: 0.4, y: 0.1, z: 0 } },
    { id: 'eps_8pin_out', slotType: 'eps_8pin', label: 'EPS 8-pin out', localPosition: { x: 0.2, y: 0.1, z: 0 } },
    { id: 'pcie_power_out', slotType: 'pcie_power', label: 'PCIe power out', localPosition: { x: 0, y: 0.1, z: 0 } },
  ],
  fitsInSlots: ['psu_bay'],
  model: 'psu',
})

// ---------------------------------------------------------------------------
// Cooling
// ---------------------------------------------------------------------------

register({
  type: 'cooler',
  name: 'CPU Cooler',
  category: 'Cooling',
  description:
    'Tower-style air cooler with heat-pipes and fan. Mounts directly on top of the CPU to dissipate heat.',
  tags: ['cooler', 'heatsink', 'fan', 'thermal', 'cooling', 'tower'],
  specs: {
    type: 'Tower air cooler',
    fanSize: '120 mm',
    heatPipes: 4,
    tdpRating: '200 W',
    noise: '24 dBA',
  },
  mountPoints: [],
  fitsInSlots: ['cooler_mount'],
  model: 'cooler',
})

// ---------------------------------------------------------------------------
// Enclosure
// ---------------------------------------------------------------------------

register({
  type: 'case',
  name: 'Chassis',
  category: 'Enclosure',
  description:
    'Mid-tower ATX case. Houses the motherboard, PSU and drives and provides airflow paths.',
  tags: ['case', 'chassis', 'tower', 'enclosure', 'housing', 'mid-tower'],
  specs: {
    formFactor: 'Mid-tower ATX',
    driveBays: '2× 3.5″, 3× 2.5″',
    fans: '3× 120 mm front, 1× 120 mm rear',
    maxGpuLength: '360 mm',
    maxCoolerHeight: '165 mm',
  },
  mountPoints: [
    { id: 'mobo_standoff', slotType: 'mobo_standoff', label: 'Motherboard standoffs', localPosition: { x: 0, y: 0.1, z: 0 } },
    { id: 'psu_bay', slotType: 'psu_bay', label: 'PSU bay', localPosition: { x: 0, y: -0.4, z: 0.3 } },
  ],
  fitsInSlots: [],
  model: 'case',
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const componentRegistry = registry

export function getDescriptor(type) {
  return registry.get(type)
}

export function allDescriptors() {
  return [...registry.values()]
}

export function searchComponents(query) {
  if (!query) return allDescriptors()
  const q = query.toLowerCase()
  return allDescriptors().filter(
    (d) =>
      d.name.toLowerCase().includes(q) ||
      d.category.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.tags.some((t) => t.includes(q)),
  )
}

/** Which slot types can accept a given component type? */
export function compatibleParents(childType) {
  const child = registry.get(childType)
  if (!child) return []
  return allDescriptors().filter((parent) =>
    parent.mountPoints.some((mp) => child.fitsInSlots.includes(mp.slotType)),
  )
}

/** Which component types can fit into any of a parent's mount points? */
export function compatibleChildren(parentType) {
  const parent = registry.get(parentType)
  if (!parent) return []
  const slotTypes = new Set(parent.mountPoints.map((mp) => mp.slotType))
  return allDescriptors().filter((child) =>
    child.fitsInSlots.some((s) => slotTypes.has(s)),
  )
}
