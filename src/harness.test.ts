import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Harness } from './harness.ts'
import { startFake } from './testing.ts'
import { UPSTREAM_TIMEOUT_MS, UpstreamError } from './upstream.ts'

const OWNER = '@alice:example.org'
const ASSISTANT = `/b2b/agents/v1/provisioning/assistants/${encodeURIComponent(OWNER)}`

let tokens: { authorization: string | undefined; body: unknown }[] = []
let tokenStatus = 200
/** The answers of the harness, in turn: each call takes the next. */
let answers: {
  status: number
  body?: unknown
  retryAfter?: string
  delayMs?: number
}[] = []
const calls: {
  method: string
  url: string
  authorization: string | undefined
  body: unknown
}[] = []
let fake: Awaited<ReturnType<typeof startFake>>
let harness: Harness

beforeAll(async () => {
  fake = await startFake(app => {
    app.post('/oauth2/token', (request, reply) => {
      tokens.push({
        authorization: request.headers.authorization,
        body: request.body
      })
      return tokenStatus === 200
        ? reply.send({
            access_token: `token-${String(tokens.length)}`,
            expires_in: 3600
          })
        : reply.code(tokenStatus).send({ error: 'invalid_client' })
    })
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      }
    )
    app.all('/b2b/agents/*', async (request, reply) => {
      calls.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: request.body
      })
      const answer = answers.shift() ?? { status: 200, body: {} }
      if (answer.delayMs) {
        await new Promise(resolve => setTimeout(resolve, answer.delayMs))
      }
      if (answer.retryAfter) void reply.header('retry-after', answer.retryAfter)
      return answer.body === undefined
        ? reply.code(answer.status).send()
        : reply.code(answer.status).send(answer.body)
    })
  })
  harness = new Harness({
    url: `${fake.url}/b2b/agents/`,
    tokenUrl: `${fake.url}/oauth2/token`,
    clientId: 'chat side',
    clientSecret: 's3cr:t',
    scope: 'openid'
  })
})

afterAll(() => fake.close())

beforeEach(() => {
  tokens = []
  tokenStatus = 200
  answers = []
  calls.length = 0
})

describe('Harness', () => {
  it('asks the assistant of the owner with a client credentials token', async () => {
    answers = [
      {
        status: 200,
        body: {
          userId: '@bot_alice:example.org',
          deviceId: 'D',
          masterKey: 'K'
        }
      }
    ]
    const fresh = new Harness({
      url: `${fake.url}/b2b/agents`,
      tokenUrl: `${fake.url}/oauth2/token`,
      clientId: 'chat side',
      clientSecret: 's3cr:t',
      scope: 'openid'
    })

    expect(
      await fresh.provisioning('PUT', OWNER, '', { timezone: 'Europe/Paris' })
    ).toEqual({
      status: 200,
      retryAfter: null,
      body: { userId: '@bot_alice:example.org', deviceId: 'D', masterKey: 'K' }
    })
    expect(tokens).toEqual([
      {
        // Form encoded before Basic (RFC 6749 §2.3.1)
        authorization: `Basic ${Buffer.from('chat+side:s3cr%3At').toString('base64')}`,
        body: { grant_type: 'client_credentials', scope: 'openid' }
      }
    ])
    expect(calls).toEqual([
      {
        method: 'PUT',
        url: ASSISTANT,
        authorization: 'Bearer token-1',
        body: { timezone: 'Europe/Paris' }
      }
    ])
  })

  it('keeps its token, and asks one for the calls that need it together', async () => {
    const fresh = new Harness({
      url: `${fake.url}/b2b/agents`,
      tokenUrl: `${fake.url}/oauth2/token`,
      clientId: 'c',
      clientSecret: 's',
      scope: 'openid'
    })
    await Promise.all([
      fresh.provisioning('GET', OWNER, '', null),
      fresh.provisioning('GET', OWNER, '/suggestions', null)
    ])
    await fresh.provisioning('GET', OWNER, '', null)

    expect(tokens).toHaveLength(1)
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${ASSISTANT}`,
      `GET ${ASSISTANT}/suggestions`,
      `GET ${ASSISTANT}`
    ])
  })

  it('hands on what the harness answers, its Retry-After and a missing body included', async () => {
    answers = [
      { status: 503, body: { error: 'not_ready' }, retryAfter: '5' },
      { status: 204 }
    ]

    expect(await harness.provisioning('GET', OWNER, '', null)).toEqual({
      status: 503,
      retryAfter: '5',
      body: { error: 'not_ready' }
    })
    expect(
      await harness.provisioning('PUT', OWNER, '/home', { roomId: '!r:e' })
    ).toEqual({ status: 204, retryAfter: null, body: null })
  })

  it('waits for a harness slower than the other services, as /home is while the assistant joins', async () => {
    answers = [
      {
        status: 409,
        body: { error: 'not a member' },
        delayMs: UPSTREAM_TIMEOUT_MS + 500
      }
    ]

    expect(
      await harness.provisioning('PUT', OWNER, '/home', { roomId: '!r:e' })
    ).toEqual({
      status: 409,
      retryAfter: null,
      body: { error: 'not a member' }
    })
  }, 10_000)

  it('asks a new token once the one it keeps nearly expires', async () => {
    let now = 0
    const fresh = new Harness(
      {
        url: `${fake.url}/b2b/agents`,
        tokenUrl: `${fake.url}/oauth2/token`,
        clientId: 'c',
        clientSecret: 's',
        scope: 'openid'
      },
      () => now
    )
    await fresh.provisioning('GET', OWNER, '', null)
    now = 3_569_000
    await fresh.provisioning('GET', OWNER, '', null)
    now = 3_571_000
    await fresh.provisioning('GET', OWNER, '', null)

    expect(tokens).toHaveLength(2)
    expect(calls.map(call => call.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-1',
      'Bearer token-2'
    ])
  })

  it('replaces a token the harness refuses, once', async () => {
    await harness.provisioning('GET', OWNER, '', null)
    tokens = []
    answers = [{ status: 401, body: { error: 'invalid token' } }]

    expect((await harness.provisioning('GET', OWNER, '', null)).status).toBe(
      200
    )
    expect(tokens).toHaveLength(1)
    expect(calls.at(-1)?.authorization).toMatch(/^Bearer token-/)
  })

  it('fails when the harness refuses the service, never handing the 401 on', async () => {
    answers = [
      { status: 401, body: { error: 'invalid token' } },
      { status: 401, body: { error: 'invalid token' } }
    ]
    await expect(
      harness.provisioning('GET', OWNER, '', null)
    ).rejects.toBeInstanceOf(UpstreamError)

    answers = [{ status: 403, body: { error: 'not a provisioner' } }]
    await expect(
      harness.provisioning('GET', OWNER, '', null)
    ).rejects.toBeInstanceOf(UpstreamError)
  })

  it('fails when the OIDC provider gives no token', async () => {
    tokenStatus = 401
    const fresh = new Harness({
      url: `${fake.url}/b2b/agents`,
      tokenUrl: `${fake.url}/oauth2/token`,
      clientId: 'c',
      clientSecret: 's',
      scope: 'openid'
    })

    await expect(
      fresh.provisioning('GET', OWNER, '', null)
    ).rejects.toBeInstanceOf(UpstreamError)
    expect(calls).toHaveLength(0)
  })
})
