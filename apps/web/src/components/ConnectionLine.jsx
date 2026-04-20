import { useMemo } from 'react'
import * as THREE from 'three'
import { getConnector } from '../domain/connectorRegistry'

export default function ConnectionLine({ from, to, type }) {
  const connector = type ? getConnector(type) : null
  const color = connector?.color || '#6366f1'

  const points = useMemo(() => {
    const start = new THREE.Vector3(from.x, from.y + 0.5, from.z)
    const end = new THREE.Vector3(to.x, to.y + 0.5, to.z)
    const mid = new THREE.Vector3(
      (start.x + end.x) / 2,
      Math.max(start.y, end.y) + 0.8,
      (start.z + end.z) / 2,
    )
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end)
    return curve.getPoints(20)
  }, [from, to])

  const geometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints(points)
  }, [points])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} linewidth={2} transparent opacity={0.7} />
    </line>
  )
}
