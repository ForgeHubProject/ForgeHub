import { useMemo } from 'react'
import * as THREE from 'three'
import { getConnector } from '../domain/connectorRegistry'

const DIFF_STYLES = {
  added: { color: '#22c55e', opacity: 0.95 },
  removed: { color: '#ef4444', opacity: 0.55 },
}

export default function ConnectionLine({ from, to, type, diffStatus = null }) {
  const connector = type ? getConnector(type) : null
  const baseColor = connector?.color || '#6366f1'
  const style = diffStatus ? DIFF_STYLES[diffStatus] : null
  const color = style?.color || baseColor
  const opacity = style?.opacity ?? 0.7

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
      <lineBasicMaterial color={color} linewidth={2} transparent opacity={opacity} />
    </line>
  )
}
