import { useAssemblyStore } from './store/useAssemblyStore'
import Canvas3D from './components/Canvas3D'
import Sidebar from './components/Sidebar'
import AssemblyTree from './components/AssemblyTree'
import Toolbar from './components/Toolbar'
import DiffPanel from './components/DiffPanel'
import SnapshotPanel from './components/SnapshotPanel'
import ComponentProperties from './components/ComponentProperties'

export default function App() {
  const viewMode = useAssemblyStore((s) => s.viewMode)

  return (
    <div className="h-full w-full flex flex-col bg-[#0d0d1a] text-gray-100">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex-1 relative">
          <Canvas3D />
          {viewMode === 'diff' && <DiffPanel />}
        </div>
        <div className="w-80 flex flex-col border-l border-gray-700/50">
          <AssemblyTree />
          <ComponentProperties />
          <SnapshotPanel />
        </div>
      </div>
    </div>
  )
}
