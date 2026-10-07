'use strict';

// Only the local Studio origin may run inside a window carrying our preload.
// Parse URLs rather than comparing prefixes (credentials/ports must not blur the
// trust boundary), and reject subframe IPC even when it happens to be same-origin.
function isStudioUrl(value, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const url = new URL(value);
    return url.origin === `http://127.0.0.1:${port}` && !url.username && !url.password;
  } catch (_) { return false; }
}

function isTrustedSender(event, port) {
  const frame = event && event.senderFrame;
  return !!frame && !frame.parent && isStudioUrl(frame.url, port);
}

module.exports = { isStudioUrl, isTrustedSender };
