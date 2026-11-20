// Live change notifications over Server-Sent Events.
//
// Every open editor keeps one EventSource on /api/events/<path>. When a page is
// saved, the server sends `change` with the new lastModified to everyone on that
// page, and the browsers fetch the new text straight away. `presence` carries the
// number of people on the page. Polling remains as the fallback when the stream
// is down, so the HTTP protocol of the specification still works on its own.

export class EventHub {
  constructor({ maxPerIp = 20, maxTotal = 5000, heartbeatMs = 25_000 } = {}) {
    this.maxPerIp = maxPerIp;
    this.maxTotal = maxTotal;
    this.channels = new Map(); // path -> Set<client>
    this.perIp = new Map(); // ip -> open streams
    this.total = 0;
    this.heartbeat = setInterval(() => this.#ping(), heartbeatMs);
    this.heartbeat.unref();
  }

  canAccept(ip) {
    return this.total < this.maxTotal && (this.perIp.get(ip) ?? 0) < this.maxPerIp;
  }

  /** Registers an open response stream for `path`. The stream is removed when it closes. */
  subscribe(path, ip, res) {
    const client = { res, ip };
    let set = this.channels.get(path);
    if (!set) this.channels.set(path, (set = new Set()));
    set.add(client);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.total += 1;

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      set.delete(client);
      if (set.size === 0 && this.channels.get(path) === set) this.channels.delete(path);
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, left);
      this.total -= 1;
      this.#presence(path);
    };
    res.on('close', remove);
    res.on('error', remove);

    this.#presence(path);
    return client;
  }

  publish(path, event, data) {
    const set = this.channels.get(path);
    if (!set) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of set) client.res.write(frame);
  }

  count(path) {
    return this.channels.get(path)?.size ?? 0;
  }

  /** Sends a last event to everyone on a page and closes their streams (the page was deleted). */
  finish(path, event, data) {
    const set = this.channels.get(path);
    if (!set) return 0;
    // Detached first, so nothing else is written to these streams while they close.
    this.channels.delete(path);
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const clients = [...set];
    for (const client of clients) client.res.end(frame);
    return clients.length;
  }

  /** Ends every stream (graceful shutdown). */
  close() {
    clearInterval(this.heartbeat);
    for (const set of this.channels.values()) {
      for (const client of set) client.res.end();
    }
  }

  #presence(path) {
    this.publish(path, 'presence', { count: this.count(path) });
  }

  #ping() {
    for (const set of this.channels.values()) {
      for (const client of set) client.res.write(': ping\n\n');
    }
  }
}
