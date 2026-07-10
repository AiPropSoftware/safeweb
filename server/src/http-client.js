// Tiny promise-based HTTP client used by the server tests and the demo script.
// (Not a runtime dependency of the server itself.)

import { request } from 'node:http';

/**
 * @param {Object} opts
 * @param {number} opts.port
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {any} [opts.body]        JSON-serialized if present
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.cookie]   cookie header to send
 * @returns {Promise<{status:number, json:any, text:string, headers:object, cookie?:string}>}
 */
export function req({ port, method, path, body, headers = {}, cookie }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { ...headers };
    if (payload) {
      h['content-type'] = 'application/json';
      h['content-length'] = payload.length;
    }
    if (cookie) h['cookie'] = cookie;
    const r = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        const setCookie = res.headers['set-cookie']?.[0];
        const sessionCookie = setCookie ? setCookie.split(';')[0] : undefined;
        resolve({ status: res.statusCode, json, text, headers: res.headers, cookie: sessionCookie });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Start an http.Server on an ephemeral port; resolves with the chosen port. */
export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
