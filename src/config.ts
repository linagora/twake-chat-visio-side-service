import { z } from 'zod'

const url = (protocol: RegExp) => z.url({ protocol })

/** The assistants are served once the harness is set, with every one of these. */
const ASSISTANTS_KEYS = [
  'ASSISTANTS_URL',
  'ASSISTANTS_TOKEN_URL',
  'ASSISTANTS_CLIENT_ID',
  'ASSISTANTS_CLIENT_SECRET'
] as const

const configSchema = z
  .object({
    AS_TOKEN: z.string().min(1),
    MATRIX_HOMESERVER_URL: url(/^https?$/),
    MATRIX_SERVER_NAME: z.string().min(1),
    DATABASE_URL: url(/^postgres(ql)?$/),
    MEET_URL: url(/^https?$/),
    MEET_CLIENT_ID: z.string().min(1),
    MEET_CLIENT_SECRET: z.string().min(1),
    MEET_SERVICE_ACCOUNT_EMAIL: z.email(),
    LDAP_URL: url(/^ldaps?$/),
    LDAP_BASE: z.string().min(1),
    LDAP_BIND_DN: z.string().min(1).optional(),
    LDAP_BIND_PASSWORD: z.string().min(1).optional(),
    LDAP_UID_ATTRIBUTE: z.string().min(1).default('uid'),
    ASSISTANTS_URL: url(/^https?$/).optional(),
    ASSISTANTS_TOKEN_URL: url(/^https?$/).optional(),
    ASSISTANTS_CLIENT_ID: z.string().min(1).optional(),
    ASSISTANTS_CLIENT_SECRET: z.string().min(1).optional(),
    ASSISTANTS_SCOPE: z.string().min(1).default('openid'),
    ASSISTANTS_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).default(60),
    HTTP_HOST: z.string().min(1).default('0.0.0.0'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info')
  })
  // A DN without a password binds anonymously, silently (RFC 4513)
  .refine(env => !env.LDAP_BIND_DN || env.LDAP_BIND_PASSWORD, {
    path: ['LDAP_BIND_PASSWORD'],
    message: 'required with LDAP_BIND_DN'
  })
  .superRefine((env, ctx) => {
    const missing = ASSISTANTS_KEYS.filter(key => env[key] === undefined)
    if (missing.length === ASSISTANTS_KEYS.length) return
    for (const key of missing) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'required with the others'
      })
    }
  })

export type Config = z.infer<typeof configSchema>

/** The configuration from the environment; an empty variable counts as unset. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== '')
  )
  const parsed = configSchema.safeParse(set)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      issue => `${issue.path.join('.')}: ${issue.message}`
    )
    throw new Error(`Invalid configuration: ${problems.join('; ')}`)
  }
  return parsed.data
}
