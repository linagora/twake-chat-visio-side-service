# Deploying

The service is the side service of Twake Chat: the MatrixRTC token service of
its calls, and the relay of its assistants to twake-harness (see
[Assistants](#assistants)). The client finds it in the client well-known and
calls `POST /sfu/get` on it directly, with an OpenID token of its homeserver.
The service checks the token and the membership with the homeserver, then asks
Meet for the LiveKit token, in the Meet room of the Matrix room.

```mermaid
sequenceDiagram
    participant C as Twake Chat
    participant V as Twake Chat side service
    participant S as Synapse
    participant L as LDAP
    participant M as Meet
    C->>V: POST /sfu/get {room, openid_token, device_id}
    V->>S: openid/userinfo (who the token stands for)
    V->>S: is_joined, power levels, display name (as_token)
    V->>L: email and Twake instance of the user
    V->>M: Meet room of the Matrix room (created once), then its livekit-token
    V-->>C: {url, jwt}
```

The service refuses, before it asks Meet:

- a user of another homeserver (403 `M_FORBIDDEN`);
- an OpenID token the homeserver rejects (401 `M_UNKNOWN_TOKEN`);
- a user who is not joined to the room (403 `M_FORBIDDEN`);
- a user without a single email in the directory (403 `M_FORBIDDEN`).

Meet refusing to act for the user (domain not allowed, no account) answers 403
`M_FORBIDDEN`. A failure of the homeserver, the directory, Postgres or Meet
answers 502, and so does a request still pending after 14 seconds (Twake Chat
gives up after 15). Moderators of the room (power level 50 or more, or a
creator from room version 12) join as `administrator` of the Meet room, the
others as `member`. The LiveKit identity is `@user:server:device`.

## Image

`ghcr.io/linagora/twake-chat-side-service`, tagged `latest` from `main`
and `X.Y.Z` from each release tag `vX.Y.Z`. Node 24; it runs as uid 1000 and
works on a read-only root filesystem, and listens on port 8080. It logs JSON
lines (pino): one per refused token and per failure.

## Routes

- `POST /sfu/get`: public, reached by browsers of any origin (CORS `*`; the
  credentials are in the body). Expose it over HTTPS. It has no rate limit of
  its own: set one at the ingress if needed.
- `GET`/`PUT /assistants/me`, `PUT /assistants/me/home`,
  `POST /assistants/me/recover`, `GET`/`PUT /assistants/me/suggestions`:
  public as well, with a rate limit per user and replica (see
  [Assistants](#assistants)). The service checks the token with Synapse before
  that limit: set a limit per IP at the ingress too.
- Liveness: `GET /health/live`.
- Readiness: `GET /health/ready`, 503 while Postgres does not answer within
  2 seconds.

## Environment

All required unless a default is given.

- `AS_TOKEN`: the `as_token` of the registration.
- `MATRIX_HOMESERVER_URL`: a listener of Synapse with the `client` resource and
  the `federation` or `openid` one (for `/_matrix/federation/v1/openid/userinfo`),
  for example `http://synapse:8008`.
- `MATRIX_SERVER_NAME`: the server name of the homeserver, whose users only
  are served.
- `DATABASE_URL`: the Postgres database, for example
  `postgres://chat_side_service:secret@postgresql:5432/chat_side_service`.
- `MEET_URL`: Meet, for example `https://meet.example.com`.
- `MEET_CLIENT_ID`, `MEET_CLIENT_SECRET`: the application of the service in
  Meet.
- `MEET_SERVICE_ACCOUNT_EMAIL`: the owner of the Meet rooms of the calls.
- `LDAP_URL`, `LDAP_BASE`: the directory, and where its users are.
- `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`: a bind that may read `mail`,
  `twakeWorkspaceUrl` and `workspaceUrl`, anonymous when unset. The password
  is required with a DN.
- `LDAP_UID_ATTRIBUTE`: the attribute that holds the Matrix localpart, `uid`
  by default.
- `ASSISTANTS_URL`, `ASSISTANTS_TOKEN_URL`, `ASSISTANTS_CLIENT_ID`,
  `ASSISTANTS_CLIENT_SECRET`: all four or none, to serve the assistants (see
  [Assistants](#assistants)). Without them, the assistant routes answer 404.
- `ASSISTANTS_SCOPE`: the scope of the client credentials request, `openid` by
  default (LemonLDAP-NG refuses a request without one).
- `ASSISTANTS_REQUESTS_PER_MINUTE`: the assistant calls a user may make per
  minute and replica, 60 by default.
- `HTTP_HOST`, `HTTP_PORT`: `0.0.0.0` and 8080 by default.
- `LOG_LEVEL`: `info` by default.

Each request to Synapse or Meet gives up after 5 seconds, and so does each step
with the directory (connection, bind, search). The token request as a whole
answers within 14 seconds.

## Well-known

The client well-known (`/.well-known/matrix/client`) names the service under
three keys, with the same URL:

- `livekit_base_url`: the one Twake Chat reads for the calls (the Flutter
  client reads only this one, the React client reads both);
- `livekit_service_url`: the one of the MatrixRTC clients of Element;
- `assistants.base_url` of the `app.twake.chat` object: the one Twake Chat
  reads for the assistants. Without it, Twake Chat shows no assistant.

```json
{
  "org.matrix.msc4143.rtc_foci": [
    {
      "type": "livekit",
      "livekit_base_url": "https://chat-side.example.com",
      "livekit_service_url": "https://chat-side.example.com"
    }
  ],
  "app.twake.chat": {
    "assistants": { "base_url": "https://chat-side.example.com" }
  }
}
```

## Meet

- The external API on (`EXTERNAL_API_ENABLED`, `APPLICATION_ENABLED`), with
  the `livekit-token/` route of the rooms
  ([linto-ai/meet#6](https://github.com/linto-ai/meet/pull/6)).
- An application with the scopes `rooms:create` and `rooms:livekit_token`.
  When it has allowed domains, they must hold the domain of every user and of
  the service account.
- `APPLICATION_ALLOW_USER_CREATION`, so that a user who never signed in to
  Meet gets an account from their email.
- The route of linto-ai/meet#6 at `e1502eb9` ignores `twake_instance`. Until
  Meet stores it, Meet knows no Drive for a user who never signed in to it,
  so their recordings and transcripts are not delivered there.
- Meet hands the LiveKit tokens of a room to the application that created it
  only. Changing `MEET_CLIENT_ID` makes each Matrix room get a new Meet room at
  its next call.

## Assistants

The service relays the assistant of the user to the provisioning API of
twake-harness, which owns the assistants as its application service. It reaches
the harness through APISIX inside the cluster, never the browser, with a token
of its own OIDC client.

```mermaid
sequenceDiagram
    participant C as Twake Chat
    participant V as Twake Chat side service
    participant S as Synapse
    participant O as LemonLDAP
    participant A as APISIX (in cluster)
    participant H as twake-harness
    C->>V: PUT /assistants/me (Bearer OpenID token, x-matrix-server-name)
    V->>S: openid/userinfo (who the token stands for)
    V->>O: client credentials token (kept until it nearly expires)
    V->>A: PUT /b2b/agents/v1/provisioning/assistants/{user}
    A->>H: same request
    H-->>V: {userId, deviceId, masterKey}
    V-->>C: {userId, deviceId, masterKey}
```

- The client sends its OpenID token in `Authorization: Bearer` and the server
  that issued it in `x-matrix-server-name`. The owner is always the user of the
  token; the routes take no other.
- The service answers what the harness answers, `Retry-After` included: a 503
  while the assistant is not ready, which the client asks again. A refusal
  keeps the `error` of the harness and gains an `errcode`: `M_BOT_NOT_FOUND` for
  `no assistant`, `M_BOT_RECOVERY_NEEDED` for `recovery_needed`, `M_UNKNOWN`
  for the other failures of its API. Any other answer, such as a route missing
  at APISIX, is logged and answers 502.
- A 401 or a 403 of the harness concerns the token of the service, never the
  user's: the service asks a new token once on a 401, then answers 502. Its own
  401 means the homeserver rejected the OpenID token.
- More than `ASSISTANTS_REQUESTS_PER_MINUTE` calls of a user in a minute answer
  429 `M_LIMIT_EXCEEDED` with a `Retry-After`. The count and the token are kept
  by each replica, unshared.
- A failure of the homeserver, LemonLDAP or the harness answers 502. The
  harness gets 12 seconds per call, since `/home` waits for the assistant to
  join the room. A request still pending after 14 seconds answers 503 with
  `Retry-After: 5`, which the client asks again.

To serve them:

- `ASSISTANTS_URL`: the harness through APISIX, before its `/v1` routes, for
  example `http://apisix-gateway.apisix.svc.cluster.local/b2b/agents`. On its
  route `b2b-agents-api`
  ([twake-workplace-cozy-apps](https://ci.linagora.com/linagora/lrs/saas/deployments/twake/twake-workplace-cozy-apps/-/blob/01eae4e5ac6dd19352e3f25553312e2e4ed50e2b/configs/apisix/apisix-contracts/values.yaml#L368)),
  APISIX adds the shared secret of the harness itself, checks the token with
  the JWKS of LemonLDAP-NG, and admits the pods of the cluster only: the
  service runs in one.
- An OIDC client of the service in LemonLDAP-NG, confidential, with the client
  credentials grant, as the tenant ToM's client `tom-<tenant>` that the harness
  already admits. Its access tokens must carry the issuer and the audience the
  harness expects (`AUTH_ISSUER`, `AUTH_AUDIENCE`). `ASSISTANTS_TOKEN_URL` is
  the token endpoint of LemonLDAP-NG, for example
  `https://auth.example.com/oauth2/token`.
- Its client id in `PROVISIONER_CLIENT_IDS` of the harness, which admits the
  provisioners by the subject of their token.
- The network: the service reaches APISIX and the token endpoint.

## LDAP

One entry per Matrix user, found under `LDAP_BASE` by
`LDAP_UID_ATTRIBUTE=<localpart>`, with a single `mail`. `twakeWorkspaceUrl`
(or the older `workspaceUrl`) goes to Meet as `twake_instance` when present.

## Postgres

A database of its own. The service creates its single table, `call_rooms`
(the Meet room of each Matrix room), at startup, so its user needs the right
to create tables. It exits when the database cannot be reached at startup.
Several replicas can share the database.

## Synapse

Synapse 1.160 or later. Copy
[`registration.example.yaml`](../registration.example.yaml), fill in the
`as_token` and any secret as `hs_token`, and list the file in
`app_service_config_files`. Then, in `homeserver.yaml`:

```yaml
experimental_features:
  msc4502_enabled: true # is_joined for application services
```

- Synapse reads the registration at startup only: restart it after any
  change.
- Only Synapse reads `id` and `sender_localpart`: a registration made with
  other values, such as `twake-chat-visio`, keeps working. To rename it, edit
  the file Synapse loads and restart it. Never list the old and the new file
  together: Synapse refuses two registrations with the same `id` or
  `as_token`.
- The registration lets the `as_token` act as any local user (the `users`
  namespace is `@.*`). Keep it as secret as an admin token.
