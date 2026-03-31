globalThis.__dirname = "/";
globalThis.__filename = "/";

// 引入 Cloudflare 的原生 TCP
import { connect } from 'cloudflare:sockets';
// 【终极黑魔法 1】：显式引入 Node.js 的 Buffer 对象
import { Buffer } from 'node:buffer';

export async function onRequest(context) {
  const { Client } = await import('ssh2');
  const { Duplex } = await import('node:stream');
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
        
        server.send('\x1b[32m[System]\x1b[0m TCP 隧道打通，注入虚拟网卡环境...\r\n');

        const writer = tcpSocket.writable.getWriter();
        const reader = tcpSocket.readable.getReader();

        // 打造无缝流转接器
        class CFBridgeStream extends Duplex {
          constructor() {
            super();
            // 【终极黑魔法 2】：强行告诉引擎管道已打开
            this.readable = true;
            this.writable = true;
            this.readyState = 'open'; 
            this._readLoop();
          }
          async _readLoop() {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) { this.push(null); break; }
                if (value) {
                    // 探针：打印进来的流量，证明服务器有回包
                    server.send(`\x1b[90m[TCP-IN] 收到 ${value.byteLength} 字节回包\x1b[0m\r\n`);
                    // 【终极黑魔法 3】：最严谨的 Uint8Array 转 Node.js Buffer 写法
                    this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                }
              }
            } catch (e) {
              this.destroy(e);
            }
          }
          _read(size) {}
          _write(chunk, encoding, callback) {
            // 探针：打印发出的流量，证明 ssh2 引擎在工作
            server.send(`\x1b[90m[TCP-OUT] 引擎发送 ${chunk.length} 字节\x1b[0m\r\n`);
            writer.write(chunk).then(() => callback()).catch(e => {
                this.destroy(e);
                callback(e);
            });
          }
          _destroy(err, callback) {
            writer.close().catch(()=>{});
            reader.cancel().catch(()=>{});
            callback(err);
          }
          
          // 模拟完整的 Node.js Socket 方法，防止引擎报错
          setTimeout() { return this; }
          setNoDelay() { return this; }
          setKeepAlive() { return this; }
          ref() { return this; }
          unref() { return this; }
        }

        const bridge = new CFBridgeStream();
        creds.sock = bridge;

        // 【终极黑魔法 4】：强行开枪！触发 connect 事件，防止 ssh2 死等
        setTimeout(() => bridge.emit('connect'), 50);

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
