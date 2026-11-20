# Redis operations

Redis is optional for the API to boot and serve traffic. PostgreSQL remains the
source of truth for accounts, sessions, messages, and collaboration data.

On the default single-instance deployment, presence and typing/recording state
are kept in process memory, and rate limits use the in-memory store. Redis is
used for shared presence/activity, rate limits, and Socket.IO pub/sub only when
`SOCKET_REDIS_ADAPTER=true`. Enable that setting only when running 2+ API
instances; configure the same Redis database for all instances. If Redis becomes
unavailable, optional Redis operations fall back to local state. Quota errors
disable Redis use for ten minutes before retrying.

Upstash's free tier allows **500,000 commands per month**. `/healthz` is
dependency-free; `/ready` checks Redis and PostgreSQL and can therefore issue a
Redis ping when explicitly requested. Do not configure a Redis-backed Render
health check.

**Nothing touches Redis on a timer while no users are connected.** Stale-socket
cleanup runs once per minute only while sockets are connected; leases are
refreshed no more often than every four minutes. Do not add short-period Redis
polling or refreshes; prefer connect/disconnect and meaningful presence changes.

Set `REDIS_URL` independently for each environment. Leave it empty when Redis
is not required. Keep `SOCKET_REDIS_ADAPTER=false` for one API instance.
