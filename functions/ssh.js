globalThis.__dirname = "/";
globalThis.__filename = "/";

// 引入 Cloudflare 官方的原生 TCP 接口
import { connect } from 'cloudflare:sockets';

export async function onRequest(context) {
  const { Client } = await import('ssh2');
  const { Duplex } = await import('node:stream'); // 引入 Node.js 标准流模块
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

  server.addEventListener('message', (event) => {
    if (!hasReceivedCreds) {
      hasReceivedCreds = true;
      try {
        const creds = JSON.parse(event.data);

        // 【核心黑客科技 3：手动桥接 TCP 管道】
        // 1. 用 Cloudflare 原生接口连上你的 VPS
        const tcpSocket = connect({ hostname: creds.host, port: parseInt(creds.port) });
        const writer = tcpSocket.writable.getWriter();
        const reader = tcpSocket.readable.getReader();

        // 2. 打造一个 Node.js 兼容的双向流 (Duplex Stream)
        class CFBridgeStream extends Duplex {
          constructor() {
            super();
            this._readLoop();
          }
          async _readLoop() {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  this.push(null);
                  break;
                }
                this.push(value); // 把 VPS 的数据推给 ssh2
              }
            } catch (e) {
              this.destroy(e);
            }
          }
          _write(chunk, encoding, callback) {
            // 把 ssh2 加密后的数据通过 Cloudflare 发给 VPS
            writer.write(chunk).then(() => callback()).catch(callback);
          }
          _destroy(err, callback) {
            writer.close().catch(()=>{});
            reader.cancel().catch(()=>{});
            callback(err);
          }
        }

        // 3. 实例化我们伪造的底层网络流
        const bridgeSocket = new CFBridgeStream();
        
        // 4. 关键点：告诉 ssh2 引擎，不要自己去创建网络，直接用我们搭好的桥！
        creds.sock = bridgeSocket;

        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              server.send('\r\n\x1b[31mShell 申请失败\x1b[0m\r\n');
              return server.close();
            }
            sshStream = stream;
            server.send('\r\n\x1b[32m[System]\x1b[0m 完美！Cloudflare 边缘节点解密成功！\r\n');
            
            stream.on('data', (data) => server.send(data.toString('utf8')));
            stream.on('close', () => server.close());
          });
        }).on('error', (err) => {
          server.send(`\r\n\x1b[31m[System] SSH 引擎报错:\x1b[0m ${err.message}\r\n`);
          server.close();
        }).connect(creds);

      } catch (e) {
        server.send(`\r\n\x1b[31m[System] 底层致命错误: ${e.message}\x1b[0m\r\n`);
        server.send(`\x1b[31m[Stack] ${e.stack}\x1b[0m\r\n`);
        server.close();
      }
    } else if (sshStream) {
      // 键盘输入直接转发
      sshStream.write(event.data);
    }
  });

  server.addEventListener('close', () => {
    if (sshClient) sshClient.end();
  });

  return new Response(null, { status: 101, webSocket: client });
}
