type NavigationGuard = () => Promise<boolean>
type Registration = { guard: NavigationGuard }
type NavigationRequest = { owner: Registration; navigate: () => void; cancelled: boolean; promise: Promise<void> }

let registration: Registration | null = null
let pending: NavigationRequest | null = null

/** A mounted workspace can finish saving before app-owned sidebar navigation. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  const owner = { guard }
  registration = owner
  return () => {
    if (registration === owner) registration = null
    // A different navigation already unmounted the owner: never redirect later.
    if (pending?.owner === owner) pending.cancelled = true
  }
}

/** Repeated shortcuts share one save, with the latest destination taking priority. */
export function navigateWithGuard(navigate: () => void): Promise<void> {
  const owner = registration
  if (!owner) { navigate(); return Promise.resolve() }
  if (pending?.owner === owner && !pending.cancelled) {
    pending.navigate = navigate
    return pending.promise
  }
  const request: NavigationRequest = { owner, navigate, cancelled: false, promise: Promise.resolve() }
  pending = request
  request.promise = Promise.resolve().then(owner.guard).then(allowed => {
    if (allowed && !request.cancelled && registration === owner) request.navigate()
  }).catch(error => {
    // A failed guard must leave the current workspace mounted.
    console.error('Unable to finish saving before navigation.', error)
  }).finally(() => {
    if (pending === request) pending = null
  })
  return request.promise
}
