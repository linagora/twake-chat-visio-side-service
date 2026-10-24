import { setTimeout as delay } from 'node:timers/promises'
import { pino } from 'pino'
import postgres from 'postgres'
import { RateLimit, registerAssistants } from './assistants.ts'
import { CallRooms } from './call-rooms.ts'
import { loadConfig } from './config.ts'
import { Directory } from './directory.ts'
import { Harness } from './harness.ts'
import { Homeserver } from './homeserver.ts'
import { createServer } from './http.ts'
import { handleSignals } from './lifecycle.ts'
import { Meet } from './meet.ts'
import { OpenId } from './openid.ts'
import { registerSfuGet } from './sfu-get.ts'

// Readiness answers 503 this long before the server closes, so the load
// balancer stops routing here first. Both fit the default 30 s grace period.
const DRAIN_MS = 5000
const SHUTDOWN_DEADLINE_MS = 25_000

const config = loadConfig()
const logger = pino({ level: config.LOG_LEVEL })
const lifecycle = handleSignals({
  log: logger,
  deadlineMs: SHUTDOWN_DEADLINE_MS
})

const connect = (max?: number) =>
  postgres(config.DATABASE_URL, {
    connect_timeout: 5,
    onnotice: () => undefined,
    ...(max && { max })
  })
const sql = connect()
// Its own connection: calls waiting for a Meet room may hold every one of the pool
const probe = connect(1)
const callRooms = new CallRooms(sql)
await callRooms.migrate()

let accepting = false
const server = createServer({
  logger,
  // A database that holds the connection without answering is not ready either
  isReady: () =>
    Promise.race([
      probe`select 1`.then(() => accepting),
      delay(2000).then(() => false)
    ])
})
const openId = new OpenId(config.MATRIX_HOMESERVER_URL)
registerSfuGet(server, {
  serverName: config.MATRIX_SERVER_NAME,
  openId,
  homeserver: new Homeserver(config.MATRIX_HOMESERVER_URL, config.AS_TOKEN),
  directory: new Directory({
    url: config.LDAP_URL,
    base: config.LDAP_BASE,
    bindDn: config.LDAP_BIND_DN ?? null,
    bindPassword: config.LDAP_BIND_PASSWORD ?? '',
    uidAttribute: config.LDAP_UID_ATTRIBUTE
  }),
  meet: new Meet({
    url: config.MEET_URL,
    clientId: config.MEET_CLIENT_ID,
    clientSecret: config.MEET_CLIENT_SECRET,
    serviceAccountEmail: config.MEET_SERVICE_ACCOUNT_EMAIL
  }),
  callRooms
})
const {
  ASSISTANTS_URL: url,
  ASSISTANTS_TOKEN_URL: tokenUrl,
  ASSISTANTS_CLIENT_ID: clientId,
  ASSISTANTS_CLIENT_SECRET: clientSecret
} = config
registerAssistants(server, {
  serverName: config.MATRIX_SERVER_NAME,
  openId,
  harness:
    url && tokenUrl && clientId && clientSecret
      ? new Harness({
          url,
          tokenUrl,
          clientId,
          clientSecret,
          scope: config.ASSISTANTS_SCOPE
        })
      : null,
  rateLimit: new RateLimit(config.ASSISTANTS_REQUESTS_PER_MINUTE)
})
await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT })

accepting = true
lifecycle.started(async () => {
  accepting = false
  await delay(DRAIN_MS)
  await server.close()
  await Promise.all([sql.end({ timeout: 5 }), probe.end({ timeout: 5 })])
})
