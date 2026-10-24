import { call, readJson, UpstreamError } from './upstream.ts'

const USERINFO_PATH = '/_matrix/federation/v1/openid/userinfo'

/**
 * The OpenID tokens a Matrix client gets from its homeserver (`/user/{userId}/openid/request_token`),
 * checked by that homeserver: the token says who stands behind a call request.
 */
export class OpenId {
  #url: string

  constructor(homeserverUrl: string) {
    this.#url = homeserverUrl.replace(/\/+$/, '')
  }

  /** The Matrix id the token stands for, or null when the homeserver rejects it. */
  async userOf(accessToken: string): Promise<string | null> {
    const response = await call(
      'homeserver',
      `${this.#url}${USERINFO_PATH}?${new URLSearchParams({ access_token: accessToken }).toString()}`
    )
    if (response.status === 401) {
      return null
    }
    const body = await readJson('homeserver', USERINFO_PATH, response)
    if (typeof body.sub !== 'string' || !/^@[^:]+:.+$/.test(body.sub)) {
      throw new UpstreamError(
        'homeserver',
        `${USERINFO_PATH} answered no user id`
      )
    }

    return body.sub
  }
}

/** A request the service turns down itself, with the answer it gets. */
export class Refusal extends Error {
  readonly status: number
  readonly errcode: string

  constructor(status: number, errcode: string, message: string) {
    super(message)
    this.status = status
    this.errcode = errcode
  }
}

const serverOf = (userId: string) => userId.slice(userId.indexOf(':') + 1)

/**
 * The user an OpenID token stands for, a user of `serverName` only: the server the
 * token claims is checked before the homeserver is asked, and the user it names after.
 */
export async function openIdUser(
  openId: Pick<OpenId, 'userOf'>,
  serverName: string,
  token: { accessToken: string; matrixServerName: string }
): Promise<string> {
  const otherServer = () =>
    new Refusal(
      403,
      'M_FORBIDDEN',
      'Only the users of this homeserver are served'
    )
  if (token.matrixServerName !== serverName) throw otherServer()
  const userId = await openId.userOf(token.accessToken)
  if (!userId) {
    throw new Refusal(
      401,
      'M_UNKNOWN_TOKEN',
      'The homeserver rejects the OpenID token'
    )
  }
  if (serverOf(userId) !== serverName) throw otherServer()
  return userId
}
