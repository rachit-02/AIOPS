/**
 * API client for the Kira dashboard server.
 *
 * Every value the UI renders comes from here — there is no mock data path and
 * no fallback sample payload, deliberately. A dashboard that silently degrades
 * to plausible-looking fake numbers when its backend dies is worse than one
 * that shows an error, because you cannot tell the difference from the screen.
 */

export async function getSystem(range = '15m') {
  const res = await fetch(`/api/system?range=${encodeURIComponent(range)}`);
  if (!res.ok) throw new Error(`system: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getServiceDetail(id, range = '15m') {
  const res = await fetch(`/api/service/${encodeURIComponent(id)}?range=${encodeURIComponent(range)}`);
  if (!res.ok) throw new Error(`service: ${res.status}`);
  return res.json();
}

export async function getIncidentHistory() {
  const res = await fetch('/api/incident/history');
  if (!res.ok) throw new Error(`history: ${res.status}`);
  return (await res.json()).events;
}

/**
 * Read a Server-Sent Events stream from a POST request.
 *
 * The browser's EventSource only does GET and cannot send a body, so the
 * stream is parsed by hand off fetch(). Events arrive as
 *   event: <name>\ndata: <json>\n\n
 * and the trailing incomplete chunk is carried into the next read — without
 * that, a tool result split across two network packets is silently dropped.
 */
export async function streamPost(url, body, onEvent, { signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        onEvent(event, JSON.parse(dataLines.join('\n')));
      } catch {
        // A malformed frame should not kill the whole stream.
      }
    }
  }
}

export const setIncident = (enabled, onEvent, opts) =>
  streamPost('/api/incident', { enabled }, onEvent, opts);

export const investigate = (question, onEvent, opts) =>
  streamPost('/api/kira/investigate', { question }, onEvent, opts);
