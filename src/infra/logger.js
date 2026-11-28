const fs = require('node:fs');
const path = require('node:path');

function redact(text) {
  return text.replace(/(\b(?:SESSDATA|bili_jct|ticket|qrcode_key)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&;\s"'#]+)/gi, '$1[REDACTED]');
}

function createLogger({ logPath, maxBytes = 5 * 1024 * 1024 }) {
  const queue = [];
  let initialized = false;
  let scheduled;
  let active;

  function rotate() {
    for (const [from, to] of [[logPath + '.1', logPath + '.2'], [logPath, logPath + '.1']]) {
      try { fs.renameSync(from, to); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function nextBatch() {
    if (!initialized) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      initialized = true;
    }
    let position = 0;
    try { position = fs.statSync(logPath).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (position && position + queue[0].length > maxBytes) {
      rotate();
      position = 0;
    }
    let count = 1;
    let bytes = queue[0].length;
    while (count < queue.length && position + bytes + queue[count].length <= maxBytes) {
      bytes += queue[count++].length;
    }
    const fd = fs.openSync(logPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    return { fd, position, data: Buffer.concat(queue.splice(0, count), bytes), written: 0 };
  }

  // A positioned write can be completed synchronously during quit, even if the
  // asynchronous write is still in flight. Both write identical bytes at the same offset.
  function writeAsync(batch) {
    fs.write(batch.fd, batch.data, batch.written, batch.data.length - batch.written,
      batch.position + batch.written, (error, bytes) => {
        if (active === batch && !error && bytes > 0) {
          batch.written += bytes;
          if (batch.written < batch.data.length) return writeAsync(batch);
        }
        fs.close(batch.fd, () => {});
        if (active !== batch) return;
        active = null;
        schedule();
      });
  }

  function schedule() {
    if (active || scheduled || !queue.length) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      try {
        active = nextBatch();
        writeAsync(active);
      } catch {
        active = null;
        queue.length = 0;
      }
    });
  }

  function log(level, message, error) {
    const detail = error?.stack || error?.message || error;
    const body = message instanceof Error ? message.stack || message.message : String(message);
    const line = new Date().toISOString() + ' [' + level + '] ' + body + (detail ? '\n' + detail : '') + '\n';
    queue.push(Buffer.from(redact(line), 'utf8'));
    schedule();
  }

  function writeRest(batch) {
    let offset = batch.written;
    while (offset < batch.data.length) {
      const bytes = fs.writeSync(batch.fd, batch.data, offset, batch.data.length - offset, batch.position + offset);
      if (!bytes) throw new Error('日志写入未取得进展');
      offset += bytes;
    }
  }

  function flushSync() {
    clearImmediate(scheduled);
    scheduled = null;
    try {
      if (active) {
        writeRest(active);
        active = null; // The outstanding callback closes its own descriptor.
      }
      while (queue.length) {
        const batch = nextBatch();
        try { writeRest(batch); } finally { fs.closeSync(batch.fd); }
      }
    } catch {
      queue.length = 0;
    }
  }

  return { log, flushSync };
}

module.exports = { createLogger };
