/**
 * Terminal Express error handler.
 *
 * The body parser rejects a malformed or oversized payload with err.status
 * already set (400, 413). Answering every one of those with a 500 blamed the
 * server for what the caller sent: /mcp is the only POST route here, and the
 * crawlers that hit it send broken JSON often enough that the noise showed up
 * as an error rate. Honour the status the error carries and keep 500 — plus
 * the stack in the log — for the faults that really are ours.
 */
export default function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(err.stack);
  }

  if (res.headersSent) {
    return next(err);
  }

  // A client that spoke JSON-RPC deserves a JSON-RPC error back, even when the
  // request never got far enough to reach the MCP transport.
  if (req.path === "/mcp") {
    return res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: status >= 500 ? -32603 : status === 413 ? -32600 : -32700,
        message: status >= 500 ? "Internal server error" : err.message,
      },
      id: null,
    });
  }

  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message,
  });
}
