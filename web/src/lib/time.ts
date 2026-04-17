export function formatTaskTime(createdAt: number): string {
  const now = Date.now()
  const diff = now - createdAt
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) return 'Today'
  if (days < 7) return `${days} days ago`
  return new Date(createdAt).toLocaleDateString()
}
