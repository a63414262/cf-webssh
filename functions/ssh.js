globalThis.__dirname = "/";
globalThis.__filename = "/";

// 【终极杀招】：直接引入原生 Node.js 物理网络模块！彻底抛弃模拟器！
import { connect } from 'node:net';

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
  let hasReceivedCreds = false; 

  server.addEventListener('message', async (event) => {
    if (!hasReceivedCreds) {
      hasReceivedCreds = true;
      try {
        const creds = JSON.parse(event.data);

        server.send('\x1b[33m[System]\x1b[0m 正在向目标服务器发起原生 TCP 握手...\r\n');

        // 核心：直接召唤 Node.js 真神！让 Cloudflare 在底层直接打通网卡
        const socket = connect({ host: creds.host, port: parseInt(creds.port) });

        socket.on('connect', () => {
            server.send('\x1b[32m[System]\x1b[0m 物理网络打通，正在进行引擎级握手...\r\n');
        });

        socket.on('error', (err) => {
            server.send(`\r\n\x1b[31m[System] 底层网络拦截:\x1b[0m ${err.message}\r\n`);
        });

        // 原生 Socket 直接喂给引擎，严丝合缝，再无缓冲卡死问题！
        creds.sock = socket;

        sshClient.on('ready', () => {
          server.send('\r\n\x1b[32m[System]\x1b[0m 密钥交换完成！正在请求 Shell...\r\n');
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              server.send('\r\n\x1b[31mShell 申请失败: ' + err.message + '\x1b[0m\r\n');
              return server.close();
            }
            sshStream = stream;
            server.send('\r\n\x1b[32m[System]\x1b[0m 🚀 成功打穿 CF 沙盒！您已获取最高控制权限。\r\n\r\n');
            
            stream.on('data', (data) => server.send(data.toString('utf8')));
            stream.on('close', () => server.close());
          });
        }).on('error', (err) => {
          server.send(`\r\n\x1b[31m[System] SSH 引擎报错:\x1b[0m ${err.message}\r\n`);
          server.close();
        }).connect(creds);

      } catch (e) {
        server.send(`\r\n\x1b[31m[System] 致命错误: ${e.message}\x1b[0m\r\n`);
        server.close();
      }
    } else if (sshStream) {
      sshStream.write(event.data);
    }
  });

  server.addEventListener('close', () => {
    if (sshClient) sshClient.end();
  });

  return new Response(null, { status: 101, webSocket: client });
}
