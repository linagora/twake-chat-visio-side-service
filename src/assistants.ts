import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Harness, HarnessAnswer } from './harness.ts'
import { corsFor, type HttpServer, matrixError, sendFailure } from './http.ts'
import { type OpenId, openIdUser, Refusal } from './openid.ts'
import { DeadlineError, withDeadline } from './upstream.ts'

export interface AssistantsDeps {
  /** The homeserver whose users are served. */
  serverName: string
  openId: Pick<OpenId, 'userOf'>
  /** None when the deployment serves no assistants: the routes answer 404. */
  harness: Pick<Harness, 'provisioning'> | null
  rateLimit: RateLimit
}

export const ASSISTANT_PATH = '/assistants/me'

/** Twake Chat gives up after 15 s: answer before, whatever is still pending. */
const DEADLINE_MS = 14_000

const WINDOW_MS = 60_000

/**
 * The calls of each user in the current minute. Each replica keeps its own, unshared:
 * a user spread over replicas gets a little more, which the limit allows for.
 */
export class RateLimit {
  readonly #perMinute: number
  readonly #now: () => number
  readonly #windows = new Map<string, { start: number; count: number }>()

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute
    this.#now = now
  }

  /** Null when the user may call, else how long before they may again, in ms. */
  take(user: string): number | null {
    const now = this.#now()
    const window = this.#windows.get(user)
    if (!window || now - window.start >= WINDOW_MS) {
      if (this.#windows.size >= 10_000) this.#forgetEnded(now)
      this.#windows.set(user, { start: now, count: 1 })
      return null
    }
    if (window.count >= this.#perMinute) return window.start + WINDOW_MS - now
    window.count += 1
    return null
  }

  #forgetEnded(now: number): void {
    for (const [user, { start }] of this.#windows) {
      if (now - start >= WINDOW_MS) this.#windows.delete(user)
    }
  }
}

/**
 * The failures the provisioning API of the harness answers, with the Matrix code of
 * each, for the clients that read it rather than the `error`, which goes on too. Any
 * other is no answer of the harness (a route missing at APISIX, a proxy error): a 502.
 */
const ERRCODES: Record<string, string> = {
  'no assistant': 'M_BOT_NOT_FOUND',
  recovery_needed: 'M_BOT_RECOVERY_NEEDED',
  'not a member': 'M_UNKNOWN',
  'not a direct room': 'M_UNKNOWN',
  'owner not on the homeserver': 'M_UNKNOWN',
  not_ready: 'M_UNKNOWN',
  'assistant creation failed': 'M_UNKNOWN'
}

/** How long the client waits before it asks again, after a request past its deadline. */
const RETRY_AFTER_DEADLINE_S = 5

const timezoneBody = z.object({
  timezone: z.string().min(1).max(64).optional()
})
const homeBody = z.object({ roomId: z.string().startsWith('!').max(255) })
const suggestionsBody = z.object({ enabled: z.boolean() })

/** The OpenID token comes in the headers, as Twake Chat sends it to every service that takes one. */
const cors = corsFor(
  'GET, PUT, POST',
  'authorization, content-type, x-matrix-server-name'
)

interface Route {
  method: 'GET' | 'PUT' | 'POST'
  suffix: string
  body: z.ZodType<Record<string, unknown>> | null
}

const ROUTES: Route[] = [
  { method: 'GET', suffix: '', body: null },
  { method: 'PUT', suffix: '', body: timezoneBody },
  { method: 'PUT', suffix: '/home', body: homeBody },
  { method: 'POST', suffix: '/recover', body: null },
  { method: 'GET', suffix: '/suggestions', body: null },
  { method: 'PUT', suffix: '/suggestions', body: suggestionsBody }
]

/**
 * The assistant of the user of an OpenID token, relayed to the provisioning API of
 * twake-harness on their behalf: `GET`/`PUT /assistants/me` (`{ userId, deviceId,
 * masterKey }`), `PUT .../home`, `POST .../recover` and `GET`/`PUT .../suggestions`.
 * The owner is always the user of the token. The harness answers as its provisioning
 * API does, its `Retry-After` included; the client asks again on a 503 or a 429.
 */
export function registerAssistants(
  app: HttpServer,
  deps: AssistantsDeps,
  { deadlineMs = DEADLINE_MS } = {}
): void {
  for (const suffix of new Set(ROUTES.map(route => route.suffix))) {
    app.options(
      `${ASSISTANT_PATH}${suffix}`,
      { onSend: cors },
      (_request, reply) => reply.code(204).send()
    )
  }
  for (const route of ROUTES) {
    app.route({
      method: route.method,
      url: `${ASSISTANT_PATH}${route.suffix}`,
      onSend: cors,
      handler: (request, reply) =>
        relay(request, reply, route, deps, deadlineMs)
    })
  }
}

async function relay(
  request: FastifyRequest,
  reply: FastifyReply,
  route: Route,
  deps: AssistantsDeps,
  deadlineMs: number
): Promise<FastifyReply> {
  const { harness } = deps
  if (!harness) {
    return reply
      .code(404)
      .send(matrixError('M_NOT_FOUND', 'No assistants are served here'))
  }
  const body = route.body ? route.body.safeParse(request.body ?? {}) : null
  if (body && !body.success) {
    const fields = body.error.issues.map(
      issue => issue.path.join('.') || 'body'
    )
    return reply
      .code(400)
      .send(matrixError('M_INVALID_PARAM', `Invalid ${fields.join(', ')}`))
  }
  const fields: { user?: string; route: string } = {
    route: `${route.method} ${route.suffix || '/'}`
  }
  let answer: HarnessAnswer | { limitedFor: number }
  try {
    answer = await withDeadline(
      (async () => {
        const user = await openIdUser(
          deps.openId,
          deps.serverName,
          tokenOf(request)
        )
        fields.user = user
        const waitMs = deps.rateLimit.take(user)
        if (waitMs !== null) return { limitedFor: waitMs }
        return harness.provisioning(
          route.method,
          user,
          route.suffix,
          body?.data ?? null
        )
      })(),
      deadlineMs
    )
  } catch (err) {
    if (err instanceof DeadlineError) {
      request.log.warn(fields, 'assistant call past its deadline')
      return reply
        .code(503)
        .header('retry-after', String(RETRY_AFTER_DEADLINE_S))
        .send(matrixError('M_UNKNOWN', 'The assistants did not answer in time'))
    }
    return sendFailure(reply, err, {
      refused: 'assistant call refused',
      fields
    })
  }
  if ('limitedFor' in answer) {
    request.log.info(fields, 'assistant call limited')
    return reply
      .code(429)
      .header('retry-after', String(Math.ceil(answer.limitedFor / 1000)))
      .send({
        ...matrixError('M_LIMIT_EXCEEDED', 'Too many requests'),
        retry_after_ms: answer.limitedFor
      })
  }
  return handOn(reply, answer)
}

/** The OpenID token and the server that issued it, from the headers. */
function tokenOf(request: FastifyRequest): {
  accessToken: string
  matrixServerName: string
} {
  const authorization = request.headers.authorization ?? ''
  const accessToken = /^Bearer (\S+)$/.exec(authorization)?.[1]
  const matrixServerName = request.headers['x-matrix-server-name']
  if (!accessToken || typeof matrixServerName !== 'string') {
    throw new Refusal(
      401,
      'M_MISSING_TOKEN',
      'An OpenID token and its x-matrix-server-name are required'
    )
  }
  return { accessToken, matrixServerName }
}

/** The answer of the harness as the client gets it; a failure of the harness is a bad gateway. */
function handOn(reply: FastifyReply, answer: HarnessAnswer): FastifyReply {
  if (answer.retryAfter) void reply.header('retry-after', answer.retryAfter)
  if (answer.status < 300) {
    return answer.body === null
      ? reply.code(answer.status).send()
      : reply.code(answer.status).send(answer.body)
  }
  const error =
    typeof answer.body === 'object' &&
    answer.body !== null &&
    'error' in answer.body &&
    typeof answer.body.error === 'string'
      ? answer.body.error
      : null
  const errcode = error === null ? undefined : ERRCODES[error]
  if (error === null || errcode === undefined) {
    reply.log.warn(
      { status: answer.status, error },
      'harness answer outside its API'
    )
    return reply
      .code(502)
      .send(matrixError('M_UNKNOWN', 'The assistants failed'))
  }
  const status =
    answer.status >= 500 && answer.status !== 503 ? 502 : answer.status
  if (status === 502) {
    reply.log.warn({ status: answer.status, error }, 'harness failure')
  }
  return reply.code(status).send(matrixError(errcode, error))
}
