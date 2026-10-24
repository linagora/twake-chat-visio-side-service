import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import type { CallRooms } from './call-rooms.ts'
import type { Directory } from './directory.ts'
import type { Homeserver } from './homeserver.ts'
import { corsFor, type HttpServer, matrixError, sendFailure } from './http.ts'
import type { CallToken, Meet, Participant } from './meet.ts'
import { type OpenId, openIdUser, Refusal } from './openid.ts'
import { UpstreamError, withDeadline } from './upstream.ts'

export interface SfuDeps {
  /** The homeserver whose users are served: the users of other homeservers are refused. */
  serverName: string
  openId: Pick<OpenId, 'userOf'>
  homeserver: Pick<Homeserver, 'isJoined' | 'isModerator' | 'displayName'>
  directory: Pick<Directory, 'entry'>
  meet: Pick<Meet, 'createRoom' | 'livekitToken'>
  callRooms: Pick<CallRooms, 'ensure' | 'forget'>
}

/** The well-known names the service (`livekit_base_url`, `livekit_service_url`); clients append `/sfu/get`. */
export const SFU_GET_PATH = '/sfu/get'

/** Twake Chat gives up after 15 s: answer before, whatever is still pending. */
const DEADLINE_MS = 14_000

/** Meet takes a `username` and an `identity` of 255 characters at most; a display name can be longer. */
const MAX_LENGTH = 255

const sfuGetBody = z.object({
  room: z.string().startsWith('!').max(MAX_LENGTH),
  openid_token: z.object({
    access_token: z.string().min(1).max(MAX_LENGTH),
    matrix_server_name: z.string().min(1).max(MAX_LENGTH)
  }),
  // Meet splits the identity at its last colon, and refuses blanks in it
  device_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^:\s]+$/)
})

/** Who asks for which room, as far as the request has told: for the logs. */
interface Context {
  room?: string
  user?: string
}

/** The request carries its credentials in its body. */
const cors = corsFor('POST', 'content-type')

const localpart = (userId: string) => userId.slice(1, userId.indexOf(':'))

/**
 * `POST /sfu/get`, the token service of the MatrixRTC calls of Twake Chat (MSC4195 before
 * its merge): the OpenID token says who calls, the homeserver whether they are in the room,
 * and Meet mints the LiveKit token in the Meet room of the Matrix room, so that recording
 * and transcription know the participant.
 */
export function registerSfuGet(
  app: HttpServer,
  deps: SfuDeps,
  { deadlineMs = DEADLINE_MS } = {}
): void {
  app.options(SFU_GET_PATH, { onSend: cors }, (_request, reply) =>
    reply.code(204).send()
  )
  app.post(SFU_GET_PATH, { onSend: cors }, async (request, reply) => {
    const body = sfuGetBody.safeParse(request.body)
    if (!body.success) {
      const fields = body.error.issues.map(
        issue => issue.path.join('.') || 'body'
      )
      request.log.info({ fields }, 'token refused: invalid request')
      return reply
        .code(400)
        .send(matrixError('M_INVALID_PARAM', `Invalid ${fields.join(', ')}`))
    }
    const context: Context = { room: body.data.room }
    try {
      const token = await withDeadline(
        sfuToken(body.data, deps, request.log, context),
        deadlineMs
      )
      request.log.info(context, 'token minted')
      return token
    } catch (err) {
      return sendFailure(reply, err, {
        refused: 'token refused',
        fields: { ...context }
      })
    }
  })
}

async function sfuToken(
  request: z.infer<typeof sfuGetBody>,
  deps: SfuDeps,
  log: FastifyBaseLogger,
  context: Context
): Promise<{ url: string; jwt: string }> {
  const {
    room: roomId,
    openid_token: openIdToken,
    device_id: deviceId
  } = request
  const userId = await openIdUser(deps.openId, deps.serverName, {
    accessToken: openIdToken.access_token,
    matrixServerName: openIdToken.matrix_server_name
  })
  context.user = userId
  // The identity every MatrixRTC client derives for this device, and the one Meet takes
  const identity = `${userId}:${deviceId}`
  if (identity.length > MAX_LENGTH) {
    throw new Refusal(
      400,
      'M_INVALID_PARAM',
      'device_id is too long for this user'
    )
  }
  if (!(await deps.homeserver.isJoined(roomId, userId))) {
    throw new Refusal(403, 'M_FORBIDDEN', 'Not joined to the room')
  }

  const [moderator, displayName, entry] = await Promise.all([
    // The role is a refinement: unreadable power levels make a member, not a failed call
    deps.homeserver.isModerator(roomId, userId).catch((err: unknown) => {
      log.warn({ err, room: roomId }, 'role unknown, joining as a member')
      return false
    }),
    deps.homeserver.displayName(userId).catch(() => null),
    deps.directory.entry(localpart(userId))
  ])
  if (!entry.email) {
    throw new Refusal(
      403,
      'M_FORBIDDEN',
      'No single email address is known for this user'
    )
  }
  const participant: Participant = {
    identity,
    // Meet refuses a blank name; by code points, as a cut through a surrogate pair is no text
    username: Array.from(displayName?.trim() || localpart(userId))
      .slice(0, MAX_LENGTH)
      .join(''),
    role: moderator ? 'administrator' : 'member',
    ...(entry.twakeInstance && { twake_instance: entry.twakeInstance })
  }
  const { url, token } = await mint(deps, roomId, entry.email, participant, log)
  return { url, jwt: token }
}

/** The token in the Meet room of the Matrix room; a room Meet no longer has is replaced, once. */
async function mint(
  deps: SfuDeps,
  roomId: string,
  email: string,
  participant: Participant,
  log: FastifyBaseLogger
): Promise<CallToken> {
  const createRoom = () => deps.meet.createRoom()
  const meetRoomId = await deps.callRooms.ensure(roomId, createRoom)
  const token = await deps.meet.livekitToken(meetRoomId, email, participant)
  if (token) return token
  log.warn(
    { room: roomId, meetRoom: meetRoomId },
    'Meet no longer has the room, replacing it'
  )
  await deps.callRooms.forget(roomId, meetRoomId)
  const replaced = await deps.callRooms.ensure(roomId, createRoom)
  const retried = await deps.meet.livekitToken(replaced, email, participant)
  if (!retried) {
    throw new UpstreamError(
      'meet',
      `the new room ${replaced} is not found either`
    )
  }
  return retried
}
