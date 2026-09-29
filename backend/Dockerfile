FROM node:20-alpine
WORKDIR /app

# Build deps and app dependencies are installed, then the build deps are
# removed, all inside ONE layer. Splitting this across multiple RUN lines
# would leave python3/make/g++ in an earlier layer even after apk del, since
# layers are immutable and only the final filesystem is squashed.
#
# They are needed at all because bcrypt is a native module with no prebuilt
# musl binaries — Alpine uses musl libc, so it falls back to compiling via
# node-gyp, which needs python3, make and a C++ toolchain.
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps

# .dockerignore keeps host .env and node_modules out of this layer.
COPY . .

EXPOSE 5000

# Drop root. The app only reads from /app, so this is safe today; revisit if
# it ever needs to write (e.g. uploads/tmp).
USER node

# Invoked through `sh` rather than executed directly so the image does not
# depend on the file's executable bit surviving the build context. The script
# itself uses `exec`, so node still ends up as PID 1 and receives SIGTERM.
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
