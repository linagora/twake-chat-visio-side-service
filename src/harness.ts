import { call, readJson, UpstreamError } from './upstream.ts'

const PROVISIONING_PATH = '/v1/provisioning/assistants'
/**
 * The harness may take seconds before it answers (`/home` waits for the assistant to
 * join the room): longer than the other calls, within the deadline of the route.
 */
const HARNESS_TIMEOUT_MS = 12_000
/** A token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 30_000
/** The lifetime of a token whose answer gives none. */
const DEFAULT_TOKEN_LIFETIME_S = 60

export interface HarnessSettings {
  /** The harness as the service reaches it: APISIX inside the cluster, before its `/v1` routes. */
  url: string
  /** The token endpoint of the OIDC provider. */
  tokenUrl: string
  clientId: string
  clientSecret: string
  /** LemonLDAP-NG refuses a client credentials request without one. */
  scope: string
}

/** What the harness answered, to hand on to the client. */
export interface HarnessAnswer {
  status: number
  retryAfter: string | null
  /** The JSON body, null without one (a 204). */
  body: unknown
}

/** A client id or secret as RFC 6749 §2.3.1 wants it before Basic: form encoded. */
const formEncode = (value: string) =>
  new URLSearchParams({ value }).toString().slice('value='.length)

/**
 * The provisioning API of twake-harness, which owns the assistants as its application
 * service. The service calls it for the user of an OpenID token, with a token of its own
 * OIDC client (client credentials), which the harness admits as a provisioner.
 */
export class Harness {
  readonly #settings: HarnessSettings
  readonly #url: string
  readonly #now: () => number
  #token: { value: string; expiresAt: number } | null = null
  /** The token request in flight, which the calls that need a token meanwhile share. */
  #tokenRequest: Promise<string> | null = null

  constructor(settings: HarnessSettings, now: () => number = Date.now) {
    this.#settings = settings
    this.#url = settings.url.replace(/\/+$/, '')
    this.#now = now
  }

  /**
   * The answer of the harness on the assistant of `ownerId`. A token it refuses
   * (expired, revoked) is replaced once; refusing the service itself is a failure,
   * never an answer for the client, which would take a 401 for its own token.
   */
  async provisioning(
    method: 'GET' | 'PUT' | 'POST',
    ownerId: string,
    suffix: string,
    body: Record<string, unknown> | null
  ): Promise<HarnessAnswer> {
    const token = await this.#accessToken()
    let response = await this.#send(token, method, ownerId, suffix, body)
    if (response.status === 401) {
      await response.body?.cancel()
      // A concurrent call may have replaced it already
      if (this.#token?.value === token) this.#token = null
      response = await this.#send(
        await this.#accessToken(),
        method,
        ownerId,
        suffix,
        body
      )
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      throw new UpstreamError(
        'harness',
        `refuses the token of the service (${String(response.status)})`
      )
    }
    const answer: unknown = await response.json().catch(() => null)
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: answer
    }
  }

  #send(
    token: string,
    method: 'GET' | 'PUT' | 'POST',
    ownerId: string,
    suffix: string,
    body: Record<string, unknown> | null
  ): Promise<Response> {
    return call(
      'harness',
      `${this.#url}${PROVISIONING_PATH}/${encodeURIComponent(ownerId)}${suffix}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body && { 'content-type': 'application/json' })
        },
        ...(body && { body: JSON.stringify(body) })
      },
      HARNESS_TIMEOUT_MS
    )
  }

  /** The token of the service, kept until it nearly expires. */
  #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.#now()) {
      return Promise.resolve(this.#token.value)
    }
    this.#tokenRequest ??= this.#requestToken().finally(() => {
      this.#tokenRequest = null
    })
    return this.#tokenRequest
  }

  async #requestToken(): Promise<string> {
    const { tokenUrl, clientId, clientSecret, scope } = this.#settings
    const credentials = Buffer.from(
      `${formEncode(clientId)}:${formEncode(clientSecret)}`
    ).toString('base64')
    const token = await readJson(
      'oidc',
      new URL(tokenUrl).pathname,
      await call('oidc', tokenUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope })
      })
    )
    if (typeof token.access_token !== 'string' || !token.access_token) {
      throw new UpstreamError('oidc', 'the token endpoint answered no token')
    }
    const lifetime =
      typeof token.expires_in === 'number' && token.expires_in > 0
        ? token.expires_in
        : DEFAULT_TOKEN_LIFETIME_S
    this.#token = {
      value: token.access_token,
      // A short-lived token is kept for half its life rather than never
      expiresAt:
        this.#now() +
        Math.max(lifetime * 1000 - TOKEN_MARGIN_MS, lifetime * 500)
    }
    return token.access_token
  }
}
