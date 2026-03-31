// 【核心黑客科技 1】：在 V8 引擎最顶层，强行伪造 Node.js 的硬盘目录变量
globalThis.__dirname = "/";
globalThis.__filename = "/";

export async function onRequest(context) {
  // 【核心黑客科技 2】：动态懒加载 (Dynamic Import)
  // 这保证了在解析 ssh2 的代码之前，我们的伪造变量已经生效！
  const { Client } = await import('ssh2');

  const { request } = context;
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let sshClient = new Client();
  let sshStream = null;

  server.addEventListener('message', (event) => {
    if (!sshStream) {
      try {
        const creds = JSON.parse(event.data);
        
        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              server.send('\r\n\x1b[31mShell 申请失败\x1b[0m\r\n');
              return server.close();
            }
            sshStream = stream;
            server.send('\r\n\x1b[32m[System]\x1b[0m Cloudflare 边缘节点解密成功！\r\n');
            
            stream.on('data', (data) => server.send(data.toString('utf8')));
            stream.on('close', () => server.close());
          });
        }).on('error', (err) => {
          server.send(`\r\n\x1b[31m[System] SSH 引擎报错:\x1b[0m ${err.message}\r\n`);
          server.close();
        }).connect(creds);

      } catch (e) {
        server.send('\r\n\x1b[31m[System] 凭证解析失败\x1b[0m\r\n');
        server.close();
      }
    } else {
      sshStream.write(event.data);
    }
  });

  server.addEventListener('close', () => {
    if (sshClient) sshClient.end();
  });

  return new Response(null, { status: 101, webSocket: client });
}
