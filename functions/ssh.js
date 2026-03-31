globalThis.__dirname = "/";
globalThis.__filename = "/";

// 引入 CF 原生 TCP
import { connect } from 'cloudflare:sockets';
// 显式引入 Node.js 核心模块
import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';

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

        server.send('\x1b[33m[System]\x1b[0m 正在向目标服务器发起真实 TCP 握手...\r\n');
        const tcpSocket = connect({ hostname: creds.host, port: parseInt(creds.port) });
        
        try {
            await tcpSocket.opened; 
        } catch (tcpErr) {
            server.send(`\r\n\x1b[31m[System] 底层 TCP 连接失败: ${tcpErr.message}\x1b[0m\r\n`);
            return server.close();
        }
        
        server.send('\x1b[32m[System]\x1b[0m TCP 隧道打通，注入纯正 Node.js 双向管道...\r\n');

        // 【终极黑魔法】：100% 符合规范的 Node.js 完美双向流
        class CFNodeSocket extends Duplex {
          constructor() {
            super();
            this.writer = tcpSocket.writable.getWriter();
            this.reader = tcpSocket.readable.getReader();
            this.readyState = 'open'; // 告诉引擎我们已经连上了
            this._readLoop();
          }

          async _readLoop() {
            try {
              while (true) {
                const { done, value } = await this.reader.read();
                if (done) { 
                    this.push(null);
                    break; 
                }
                if (value) {
                    server.send(`\x1b[90m[TCP-IN] 收到 ${value.byteLength} 字节\x1b[0m\r\n`);
                    // 严格转换为 Node.js Buffer
                    this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                }
              }
            } catch (e) {
              this.destroy(e);
            }
          }

          _read(size) {
            // 必须存在，以符合 Duplex 规范
          }

          _write(chunk, encoding, callback) {
            server.send(`\x1b[90m[TCP-OUT] 发送 ${chunk.length} 字节\x1b[0m\r\n`);
            // Cloudflare writer 严格要求 Uint8Array
            this.writer.write(new Uint8Array(chunk)).then(() => {
                callback();
            }).catch(e => {
                callback(e);
            });
          }

          _destroy(err, callback) {
            this.writer.close().catch(()=>{});
            this.reader.cancel().catch(()=>{});
            callback(err);
          }

          // 补齐 net.Socket 的专属方法
          setTimeout() { return this; }
          setNoDelay() { return this; }
          setKeepAlive() { return this; }
          ref() { return this; }
          unref() { return this; }
        }

        const bridge = new CFNodeSocket();
        creds.sock = bridge;

        sshClient.on('ready', () => {
          server.send('\r\n\x1b[32m[System]\x1b[0m 密钥交换完成！正在请求 Shell...\r\n');
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              server.send('\r\n\x1b[31mShell 申请失败\x1b[0m\r\n');
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

        // 强行触发动机：告诉 ssh2 管道已就绪，立刻开始握手！
        setTimeout(() => bridge.emit('connect'), 50);

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
