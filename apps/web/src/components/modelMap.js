import {
  CaseModel,
  CoolerModel,
  CpuModel,
  GpuModel,
  MotherboardModel,
  PsuModel,
  RamModel,
  SsdModel,
} from './models'

export const MODEL_MAP = {
  cpu: CpuModel,
  ram: RamModel,
  motherboard: MotherboardModel,
  gpu: GpuModel,
  ssd: SsdModel,
  psu: PsuModel,
  cooler: CoolerModel,
  case: CaseModel,
}
