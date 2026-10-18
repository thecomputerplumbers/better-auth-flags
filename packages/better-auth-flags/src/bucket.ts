/**
 * Stable rollout bucketing: maps (flag key, subject id) to an integer in
 * [0, 10000). Uses 32-bit FNV-1a so it runs identically in Node, Workers and
 * browsers with no dependencies. Changing this function is a breaking change.
 */
export function bucket(flagKey: string, subjectId: string): number {
  const input = `${flagKey}:${subjectId}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 10000
}
