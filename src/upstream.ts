/** Every call to the homeserver, the directory or Meet gives up after this. */
export const UPSTREAM_TIMEOUT_MS = 5000

/** A service the token depends on failed: the caller gets a 502. */
export class UpstreamError extends Error {
  constructor(service: string, detail: string) {
    super(`${service}: ${detail}`)
    this.name = 'UpstreamError'
  }
}

/** A service the token depends on refuses this user: the caller gets a 403. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefusedError'
  }
}

/** The JSON body of an answer, or an `UpstreamError` that says which call failed. */
export async function readJson(
  service: string,
  path: string,
  response: Response
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new UpstreamError(
      service,
      `${path} answered ${String(response.status)}`
    )
  }
  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) {
    throw new UpstreamError(service, `${path} answered no JSON object`)
  }

  return body as Record<string, unknown>
}

/** A request still pending at its deadline: an `UpstreamError`, which a route may answer apart. */
export class DeadlineError extends UpstreamError {
  constructor(deadlineMs: number) {
    super('deadline', `no answer within ${String(deadlineMs)} ms`)
    this.name = 'DeadlineError'
  }
}

/** The work, or a `DeadlineError` once `deadlineMs` passed, whatever is still pending. */
export function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(deadlineMs))
    }, deadlineMs)
  })
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer)
  })
}

/** `fetch`, with the timeout, and a network failure turned into an `UpstreamError`. */
export async function call(
  service: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw new UpstreamError(
      service,
      `${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
