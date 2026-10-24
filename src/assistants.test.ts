import { pino } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AssistantsDeps,
  RateLimit,
  registerAssistants
} from './assistants.ts'
import type { HarnessAnswer } from './harness.ts'
import { createServer } from './http.ts'
import { UpstreamError } from './upstream.ts'

const ALICE = '@alice:example.org'
const BOT = { userId: '@bot_alice:example.org', deviceId: 'D', masterKey: 'K' }
const HEADERS = {
  authorization: 'Bearer openid',
  'x-matrix-server-name': 'example.org'
}

const answer = (
  status: number,
  body: unknown = null,
  retryAfter: string | null = null
): HarnessAnswer => ({ status, body, retryAfter })

function fakes() {
  return {
    serverName: 'example.org',
    openId: {
      userOf: vi.fn<(token: string) => Promise<string | null>>(() =>
        Promise.resolve(ALICE)
      )
    },
    harness: {
      provisioning: vi.fn<
        (
          method: 'GET' | 'PUT' | 'POST',
          owner: string,
          suffix: string,
          body: Record<string, unknown> | null
        ) => Promise<HarnessAnswer>
      >(() => Promise.resolve(answer(200, BOT)))
    },
    rateLimit: new RateLimit(60)
  } satisfies AssistantsDeps
}

let deps = fakes()

function app(overrides: Partial<AssistantsDeps> = {}, deadlineMs?: number) {
  const server = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  registerAssistants(
    server,
    { ...deps, ...overrides },
    deadlineMs === undefined ? {} : { deadlineMs }
  )
  return server
}

function ask(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = HEADERS
) {
  return app().inject({
    method,
    url,
    headers,
    ...(payload !== undefined && {
      payload: payload as Record<string, unknown>
    })
  })
}

beforeEach(() => {
  deps = fakes()
})

describe('the assistant routes', () => {
  it('relay each route to the assistant of the user of the token', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/assistants/me'],
      ['PUT', '/assistants/me', { timezone: 'Europe/Paris' }],
      ['PUT', '/assistants/me/home', { roomId: '!room:example.org' }],
      ['POST', '/assistants/me/recover'],
      ['GET', '/assistants/me/suggestions'],
      ['PUT', '/assistants/me/suggestions', { enabled: false }]
    ]
    for (const [method, url, body] of calls) {
      await ask(method as 'GET', url, body)
    }

    expect(deps.openId.userOf).toHaveBeenCalledWith('openid')
    expect(deps.harness.provisioning.mock.calls).toEqual([
      ['GET', ALICE, '', null],
      ['PUT', ALICE, '', { timezone: 'Europe/Paris' }],
      ['PUT', ALICE, '/home', { roomId: '!room:example.org' }],
      ['POST', ALICE, '/recover', null],
      ['GET', ALICE, '/suggestions', null],
      ['PUT', ALICE, '/suggestions', { enabled: false }]
    ])
  })

  it('answer what the harness answers, to the browsers of any origin', async () => {
    const response = await ask('PUT', '/assistants/me', {})

    expect([response.statusCode, response.json()]).toEqual([200, BOT])
    expect(response.headers['access-control-allow-origin']).toBe('*')

    deps.harness.provisioning.mockResolvedValueOnce(answer(204))
    const home = await ask('PUT', '/assistants/me/home', {
      roomId: '!room:example.org'
    })
    expect([home.statusCode, home.body]).toEqual([204, ''])

    deps.harness.provisioning.mockResolvedValueOnce(
      answer(202, { queued: true })
    )
    const recover = await ask('POST', '/assistants/me/recover')
    expect([recover.statusCode, recover.json()]).toEqual([
      202,
      { queued: true }
    ])
  })

  it('answer the preflight of each route', async () => {
    for (const suffix of ['', '/home', '/recover', '/suggestions']) {
      const response = await app().inject({
        method: 'OPTIONS',
        url: `/assistants/me${suffix}`
      })

      expect(response.statusCode).toBe(204)
      expect(response.headers['access-control-allow-headers']).toBe(
        'authorization, content-type, x-matrix-server-name'
      )
      expect(response.headers['access-control-expose-headers']).toBe(
        'retry-after'
      )
    }
  })

  it('hand on the refusals of the harness with their error, and a Matrix code where the client reads one', async () => {
    const cases: [HarnessAnswer, number, Record<string, string>][] = [
      [
        answer(404, { error: 'no assistant' }),
        404,
        { errcode: 'M_BOT_NOT_FOUND', error: 'no assistant' }
      ],
      [
        answer(409, { error: 'recovery_needed' }),
        409,
        { errcode: 'M_BOT_RECOVERY_NEEDED', error: 'recovery_needed' }
      ],
      [
        answer(409, { error: 'not a member' }),
        409,
        { errcode: 'M_UNKNOWN', error: 'not a member' }
      ],
      [
        answer(409, { error: 'not a direct room' }),
        409,
        { errcode: 'M_UNKNOWN', error: 'not a direct room' }
      ],
      [
        answer(422, { error: 'owner not on the homeserver' }),
        422,
        { errcode: 'M_UNKNOWN', error: 'owner not on the homeserver' }
      ],
      [
        answer(502, { error: 'assistant creation failed' }),
        502,
        { errcode: 'M_UNKNOWN', error: 'assistant creation failed' }
      ],
      [
        answer(500),
        502,
        { errcode: 'M_UNKNOWN', error: 'The assistants failed' }
      ]
    ]
    for (const [harnessAnswer, status, body] of cases) {
      deps.harness.provisioning.mockResolvedValueOnce(harnessAnswer)
      const response = await ask('GET', '/assistants/me')

      expect([response.statusCode, response.json()]).toEqual([status, body])
    }
  })

  it('answer 502 to what the harness never answers, such as a route missing at APISIX', async () => {
    for (const harnessAnswer of [
      answer(404, { error_msg: '404 Route Not Found' }),
      answer(400, { error: 'invalid body' })
    ]) {
      deps.harness.provisioning.mockResolvedValueOnce(harnessAnswer)
      const response = await ask('GET', '/assistants/me')

      expect([response.statusCode, response.json()]).toEqual([
        502,
        { errcode: 'M_UNKNOWN', error: 'The assistants failed' }
      ])
    }
  })

  it('hand on the 503 of an assistant not ready yet, with its Retry-After', async () => {
    deps.harness.provisioning.mockResolvedValueOnce(
      answer(503, { error: 'not_ready' }, '5')
    )
    const response = await ask('PUT', '/assistants/me', {})

    expect(response.statusCode).toBe(503)
    expect(response.headers['retry-after']).toBe('5')
  })

  it('refuse a request without an OpenID token, or with one the homeserver rejects', async () => {
    const missing = await ask('GET', '/assistants/me', undefined, {})
    expect([
      missing.statusCode,
      missing.json<{ errcode: string }>().errcode
    ]).toEqual([401, 'M_MISSING_TOKEN'])

    deps.openId.userOf.mockResolvedValueOnce(null)
    const rejected = await ask('GET', '/assistants/me')
    expect(rejected.statusCode).toBe(401)

    const otherServer = await ask('GET', '/assistants/me', undefined, {
      ...HEADERS,
      'x-matrix-server-name': 'other.org'
    })
    expect(otherServer.statusCode).toBe(403)
    expect(deps.harness.provisioning).not.toHaveBeenCalled()
  })

  it('refuse a body of the wrong shape, before asking anyone', async () => {
    const bodies: [string, unknown][] = [
      ['/assistants/me', { timezone: 3 }],
      ['/assistants/me/home', { roomId: '#alias:example.org' }],
      ['/assistants/me/home', {}],
      ['/assistants/me/suggestions', { enabled: 'no' }]
    ]
    for (const [url, body] of bodies) {
      const response = await ask('PUT', url, body)

      expect([
        response.statusCode,
        response.json<{ errcode: string }>().errcode
      ]).toEqual([400, 'M_INVALID_PARAM'])
    }
    expect(deps.openId.userOf).not.toHaveBeenCalled()
  })

  it('pass on nothing but the fields the harness takes', async () => {
    await ask('PUT', '/assistants/me', {
      timezone: 'Europe/Paris',
      owner: '@bob:example.org'
    })

    expect(deps.harness.provisioning).toHaveBeenCalledWith('PUT', ALICE, '', {
      timezone: 'Europe/Paris'
    })
  })

  it('limit the calls of each user, with a Retry-After', async () => {
    const limited = app({ rateLimit: new RateLimit(2) })
    const get = () =>
      limited.inject({ method: 'GET', url: '/assistants/me', headers: HEADERS })
    await get()
    await get()
    const third = await get()

    expect(third.statusCode).toBe(429)
    expect(third.json<{ errcode: string }>().errcode).toBe('M_LIMIT_EXCEEDED')
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
    expect(deps.harness.provisioning).toHaveBeenCalledTimes(2)
  })

  it('answer 502 when the harness fails', async () => {
    deps.harness.provisioning.mockRejectedValueOnce(
      new UpstreamError('harness', 'refuses the token of the service (403)')
    )
    expect((await ask('GET', '/assistants/me')).statusCode).toBe(502)
  })

  it('answer 503 before the client gives up, for it to ask again', async () => {
    deps.harness.provisioning.mockReturnValueOnce(new Promise(() => undefined))
    const slow = await app({}, 20).inject({
      method: 'GET',
      url: '/assistants/me',
      headers: HEADERS
    })

    expect(slow.statusCode).toBe(503)
    expect(slow.headers['retry-after']).toBe('5')
  })

  it('answer 404 when the deployment serves no assistants', async () => {
    const response = await app({ harness: null }).inject({
      method: 'GET',
      url: '/assistants/me',
      headers: HEADERS
    })

    expect([
      response.statusCode,
      response.json<{ errcode: string }>().errcode
    ]).toEqual([404, 'M_NOT_FOUND'])
    expect(deps.openId.userOf).not.toHaveBeenCalled()
  })
})

describe('RateLimit', () => {
  it('lets a user call again once the minute ends', () => {
    let now = 0
    const limit = new RateLimit(1, () => now)

    expect(limit.take(ALICE)).toBeNull()
    expect(limit.take(ALICE)).toBe(60_000)
    expect(limit.take('@bob:example.org')).toBeNull()
    now = 60_000
    expect(limit.take(ALICE)).toBeNull()
  })
})
