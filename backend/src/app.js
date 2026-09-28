const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const env = require('./config/env');
const routes = require('./routes');
const errorMiddleware = require('./middlewares/error.middleware');

const app = express();

app.use(helmet());
app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));
// Cap JSON bodies. Attachments are uploaded as multipart to /upload, so
// message payloads stay small (BACKEND_TASKS.md Bug 14).
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', routes);

app.use(errorMiddleware);

module.exports = app;
