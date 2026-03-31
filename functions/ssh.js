import { connect } from 'cloudflare:sockets';

export async function onRequest(context) {
  const { request } = context;
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });

  const url = new URL(request.url);
  const host = url.searchParams.get('host');
  const port = url.searchParams.get('port') || 22;

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  try {
    const tcpSocket = connect({ hostname: host, port: parseInt(port) });
    const tcpWriter = tcpSocket.writable.getWriter();
    const tcpReader = tcpSocket.readable.getReader();

    server.addEventListener('message', async (event) => {
      if (event.data) await tcpWriter.write(event.data);
    });

    (async () => {
      try {
        while (true) {
          const { done, value } = await tcpReader.read();
          if (done) break;
          server.send(value);
        }
      } catch (e) { /* ignore */ }
    })();

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    return new Response('TCP Failed', { status: 500 });
  }
}
