globalThis.__dirname = "/";
globalThis.__filename = "/";

export async function onRequest(context) {
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
  
  // 核心修复：增加一个锁，防止你在连接期间不小心敲击键盘导致 JSON 解析崩溃
  let hasReceivedCreds = false; 

  server.addEventListener('message', (event) => {
    if (!hasReceivedCreds) {
      hasReceivedCreds = true; // 锁定：只解析第一次发来的 JSON 凭证
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
          // 这里捕捉的是 SSH 握手失败、密码错误等网络层面的报错
          server.send(`\r\n\x1b[31m[System] SSH 引擎报错:\x1b[0m ${err.message}\r\n`);
          server.close();
        }).connect(creds);

      } catch (e) {
        // 这里捕捉的是 V8 引擎解析私钥时发生的底层崩溃，我们把它完整打印出来！
        server.send(`\r\n\x1b[31m[System] 底层致命错误: ${e.message}\x1b[0m\r\n`);
        server.send(`\x1b[31m[Stack] ${e.stack}\x1b[0m\r\n`);
        server.close();
      }
    } else if (sshStream) {
      // 只有 SSH 流建立后，才允许发送键盘字符
      sshStream.write(event.data);
    }
  });

  server.addEventListener('close', () => {
    if (sshClient) sshClient.end();
  });

  return new Response(null, { status: 101, webSocket: client });
}
