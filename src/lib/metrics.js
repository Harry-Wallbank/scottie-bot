// Lightweight Prometheus metrics for observability (message/request counts
// split by DM vs guild slash commands). Exposes /metrics on :9464 for
// Prometheus to scrape - not used anywhere in the bot's actual logic.
const http = require('node:http');
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const requestsReceived = new client.Counter({
  name: 'bot_requests_received_total',
  help: 'Requests received by the bot, split by type',
  labelNames: ['type'],
  registers: [register],
});

const messagesSent = new client.Counter({
  name: 'bot_messages_sent_total',
  help: 'Messages sent by the bot, split by type',
  labelNames: ['type'],
  registers: [register],
});

function startMetricsServer(port = 9464) {
  http
    .createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } else {
        res.statusCode = 404;
        res.end();
      }
    })
    .listen(port, '0.0.0.0', () => console.log(`metrics server listening on :${port}`));
}

module.exports = { requestsReceived, messagesSent, startMetricsServer };
