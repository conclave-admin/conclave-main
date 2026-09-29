#!/bin/sh
# Applies pending migrations, then starts the server in the foreground.
#
# Why this exists: nothing ran migrations before, so `docker compose up` brought
# up a healthy backend against an empty database and every query failed with
# `relation "users" does not exist`. A container that starts is not the same as a
# container that is ready to serve.
#
# `exec` is load-bearing. Without it this script stays PID 1 and node is its
# child, so the SIGTERM Docker sends on stop lands on the shell and the graceful
# shutdown in src/server.js never runs — the pool and Redis connections are
# never drained. `exec` replaces the shell, making node PID 1 so it receives
# SIGTERM directly.
#
# Safe to run on every start: migrate.js records applied filenames in
# schema_migrations and skips them, so this is a no-op once the database is
# current. It is NOT safe to run from several replicas at once — the ledger has
# no advisory lock, so two concurrent runners can apply the same file. For a
# single instance this is fine; see the deployment notes for the multi-replica
# case.
set -e

echo "[entrypoint] applying migrations"
node database/migrate.js

echo "[entrypoint] starting server"
exec node src/server.js
