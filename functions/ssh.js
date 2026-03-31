import { Client } from 'ssh2';

export async function onRequest(context) {
  const { request } = context;

  // 1. 确保是 WebSocket 请求
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  // 2. 创建 WebSocket 对
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let sshClient = new Client();
  let sshStream = null;

  // 3. 监听前端发来的数据
  server.addEventListener('message', (event) => {
    // 如果 SSH 流还没建立，说明收到的第一条消息是包含账号密码的认证 JSON
    if (!sshStream) {
      try {
        const creds = JSON.parse(event.data);
        
        // 配置 SSH 连接事件
        sshClient.on('ready', () => {
          // 申请一个自带颜色的伪终端 (PTY)
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              server.send('\r\n\x1b[31m[System]\x1b[0m 申请 Shell 失败\r\n');
              server.close();
              return;
            }
            sshStream = stream;
            server.send('\r\n\x1b[32m[System]\x1b[0m 认证成功！已进入安全终端。\r\n');
            
            // 将 VPS 的输出数据发给前端
            stream.on('data', (data) => {
              server.send(data.toString('utf8'));
            });
            
            stream.on('close', () => {
              server.send('\r\n\x1b[31m[System]\x1b[0m 会话结束\r\n');
              server.close();
            });
          });
        }).on('error', (err) => {
          server.send(`\r\n\x1b[31m[System]\x1b[0m SSH 错误: ${err.message}\r\n`);
          server.close();
        }).connect({
          host: creds.host,
          port: parseInt(creds.port),
          username: creds.username,
          password: creds.password,
          readyTimeout: 15000 // 15秒超时
        });

      } catch (e) {
        server.send('\r\n\x1b[31m[System]\x1b[0m 凭证解析失败\r\n');
        server.close();
      }
    } else {
      // 如果 SSH 流已经建立，说明收到的是你敲击键盘的字符，直接发给 VPS
      sshStream.write(event.data);
    }
  });

  server.addEventListener('close', () => {
    if (sshClient) sshClient.end();
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
