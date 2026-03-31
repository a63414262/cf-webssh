import { Client } from 'ssh2';

export async function onRequest(context) {
  const { request } = context;
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let sshClient = new Client();
  let sshStream = null;

  server.addEventListener('message', (event) => {
    // 首次通信：接收前端发来的 JSON 凭证并解密
    if (!sshStream) {
      try {
        const creds = JSON.parse(event.data);
        
        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) { server.send('\r\n\x1b[31mShell 申请失败\x1b[0m\r\n'); return server.close(); }
            sshStream = stream;
            server.send('\r\n\x1b[32m[System]\x1b[0m Cloudflare 边缘节点解密成功！\r\n');
            
            stream.on('data', (data) => server.send(data.toString('utf8')));
            stream.on('close', () => server.close());
          });
        }).on('error', (err) => {
          server.send(`\r\n\x1b[31m[System] SSH 错误:\x1b[0m ${err.message}\r\n`);
          server.close();
        }).connect(creds);
      } catch (e) {
        server.send('\r\n\x1b[31m[System] 凭证解析失败\x1b[0m\r\n');
        server.close();
      }
    } else {
      // 终端通信：直接将键盘字符发给 SSH 流
      sshStream.write(event.data);
    }
  });

  server.addEventListener('close', () => { if (sshClient) sshClient.end(); });

  return new Response(null, { status: 101, webSocket: client });
}
