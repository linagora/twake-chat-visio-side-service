# twake-chat-side-service

Matrix application service of Twake Chat. It issues the call tokens through
Meet and relays the assistants to twake-harness.
Deploying it: [docs/deploy.md](docs/deploy.md).

## Development

Needs Node 24 and a Postgres for the tests (`TEST_DATABASE_URL`, by default
`postgres://postgres:postgres@localhost:5432/postgres`).

```sh
npm ci
npm run check   # lint, format, type check, tests, build
npm run dev     # reads .env, see docs/deploy.md for the variables
```
