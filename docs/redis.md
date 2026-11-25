# Redis operations

Redis is optional for the API to boot and serve traffic. PostgreSQL remains the
source of truth for accounts, sessions, messages, and collaboration data.

Presence and typing/recording state use process memory unless Redis is
configured. Rate limits use Redis when it is ready; in production, they fall
back to atomic PostgreSQL counters shared across API instances if Redis is
missing or unavailable. Migration `076_postgres_rate_limit_fallback.sql` must
be applied. Rate-limited requests return a retryable 503 only if PostgreSQL is
also unavailable. In development without Redis, rate limits use local memory.
Socket.IO pub/sub uses Redis only when `SOCKET_REDIS_ADAPTER=true`; enable that
setting only when running 2+ API instances and configure the same Redis
database for all instances. Redis quota errors disable Redis use for ten
minutes before retrying.

Upstash's free tier allows **500,000 commands per month**. `/healthz` is
dependency-free; `/ready` checks Redis and PostgreSQL and can therefore issue a
Redis ping when explicitly requested. Do not configure a Redis-backed Render
health check.

**Nothing touches Redis on a timer while no users are connected.** Stale-socket
cleanup runs once per minute only while sockets are connected; leases are
refreshed no more often than every four minutes. Do not add short-period Redis
polling or refreshes; prefer connect/disconnect and meaningful presence changes.

Set `REDIS_URL` independently for each environment if Redis-backed presence or
Socket.IO pub/sub is wanted. It is optional for login and other rate-limited
requests because production rate limits fall back to PostgreSQL. Keep
`SOCKET_REDIS_ADAPTER=false` for one API instance.
