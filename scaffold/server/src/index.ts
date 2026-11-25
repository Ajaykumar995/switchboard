import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { healthCheck } from './health.js';
import { rawBodyMiddleware, handlePigeonWebhook } from './webhook.js';
import { graderReset, graderSnapshot, graderClaim, graderReply } from './grader.js';
import { runDeliveryWorker } from './worker.js';

const app = express();

// Parse JSON for all routes except webhook (which needs raw body)
app.use((req, res, next) => {
  if (req.path === '/webhooks/pigeon') {
    return next();
  }
  express.json()(req, res, next);
});

// Health check
app.get('/healthz', healthCheck);

// Pigeon webhook - needs raw body for HMAC verification
app.post('/webhooks/pigeon', rawBodyMiddleware, handlePigeonWebhook);

// Grader endpoints
app.post('/__grader/reset', graderReset);
app.get('/__grader/snapshot', graderSnapshot);
app.post('/__grader/claim', graderClaim);
app.post('/__grader/reply', graderReply);

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);

  // Start delivery worker
  runDeliveryWorker().catch(err => {
    console.error('Failed to start delivery worker:', err);
  });
});