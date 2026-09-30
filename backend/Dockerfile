FROM node:20-alpine
WORKDIR /app

# No build toolchain here. bcrypt is the only native module, and it ships a
# prebuilt linux-musl binary that node-pre-gyp fetches at install time, so it
# does not compile. An earlier revision installed python3/make/g++ on the
# assumption that Alpine's musl libc meant no prebuilt binary existed. That was
# wrong: installing and running bcrypt in node:20-alpine with no compiler
# present succeeded in 17s. The toolchain also caused a ~40MB python3 download
# that stalled the Alpine CDN and left a build hanging for 48 minutes. If a
# future dependency genuinely needs to compile, add the toolchain back here
# rather than debugging a node-gyp error at runtime.
COPY package*.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

# .dockerignore keeps the host's .env and node_modules out of this layer.
# Without it, host (glibc) node_modules would overwrite these musl-built ones
# and the image would build cleanly and then crash on startup.
COPY . .

EXPOSE 5000

# Drop root. The app only reads from /app today; revisit if it needs to write
# (e.g. uploads/tmp).
USER node

# Invoked through `sh` rather than executed directly so the image does not
# depend on the file's executable bit surviving the build context. The script
# itself uses `exec`, so node still ends up as PID 1 and receives SIGTERM.
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
