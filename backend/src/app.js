const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const env = require('./config/env');
const routes = require('./routes');
const errorMiddleware = require('./middlewares/error.middleware');
const { fail } = require('./utils/apiResponse');

const app = express();

app.use(helmet());
app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));
// Cap JSON bodies. Attachments are uploaded as multipart to /upload, so
// message payloads stay small (BACKEND_TASKS.md Bug 14).
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', routes);

// 404 for anything that matched no route. Without this Express falls through to
// its own default handler, which returns an HTML page — so a mistyped /api path
// gave the client a different content type and shape from every other response.
// Registered after the routers so it only catches genuinely-unmatched paths, and
// before errorMiddleware (which is 4-arg and only runs on thrown errors).
app.use((req, res) => fail(res, 'Route not found', 404));

app.use(errorMiddleware);

module.exports = app;
