import { connect } from 'cloudflare:sockets';

export async function onRequest(context) {
  const { request } = context;
  
  // 1. 检查是否是 WebSocket 升级请求
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  // 2. 从 URL 获取目标 VPS 的 IP 和端口
  const url = new URL(request.url);
  const host = url.searchParams.get('host');
  const port = url.searchParams.get('port') || 22;

  if (!host) {
    return new Response('Missing target host', { status: 400 });
  }

  // 3. 创建 WebSocket 对
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  // 接受 WebSocket 连接
  server.accept();

  try {
    // 4. 使用 Cloudflare 的底层 Socket 直连 VPS
    const tcpSocket = connect({ hostname: host, port: parseInt(port) });
    
    // 打开 TCP 的读写流
    const tcpWriter = tcpSocket.writable.getWriter();
    const tcpReader = tcpSocket.readable.getReader();

    // 5. 将 WebSocket 收到的数据写入 TCP (浏览器 -> VPS)
    server.addEventListener('message', async (event) => {
      if (event.data) {
        await tcpWriter.write(event.data);
      }
    });

    // 6. 将 TCP 收到的数据发回 WebSocket (VPS -> 浏览器)
    (async () => {
      try {
        while (true) {
          const { done, value } = await tcpReader.read();
          if (done) break;
          server.send(value);
        }
      } catch (e) {
        console.error("TCP read error", e);
      }
    })();

    // 7. 返回 101 状态码，建立连接
    return new Response(null, {
      status: 101,
      webSocket: client,
    });

  } catch (err) {
    return new Response('TCP Connection Failed: ' + err.message, { status: 500 });
  }
}
