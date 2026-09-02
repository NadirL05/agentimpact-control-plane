import { createServer, type Server } from 'node:http';
import type { RouterMetrics } from './metrics.js';

export function startHealthServer(
  port: number,
  getMetrics: () => RouterMetrics,
  isReady: () => boolean,
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/readyz') {
      if (isReady()) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ready');
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('not_ready');
      }
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getMetrics()));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1');
  return server;
}
