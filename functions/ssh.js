globalThis.__dirname = "/";
globalThis.__filename = "/";

// 引入 CF 原生 TCP
import { connect } from 'cloudflare:sockets';
// 引入 Node.js 核心事件器和 Buffer
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

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
        
        server.send('\x1b[32m[System]\x1b[0m TCP 隧道打通，注入纯净直通套接字...\r\n');

        // 【终极黑魔法】：彻底抛弃 Node.js 臃肿的 Duplex 流
        // 手写一个透明的 FakeSocket，绝不吞噬任何一个字节
        class FakeSocket extends EventEmitter {
            constructor() {
                super();
                this.readyState = 'open'; // 告诉引擎管道已大开
                this.writer = tcpSocket.writable.getWriter();
                this.reader = tcpSocket.readable.getReader();
                this._readLoop();
            }
            async _readLoop() {
                try {
                    while (true) {
                        const { done, value } = await this.reader.read();
                        if (done) { 
                            this.emit('end');
                            this.emit('close');
                            break; 
                        }
                        if (value) {
                            server.send(`\x1b[90m[TCP-IN] 收到 ${value.byteLength} 字节\x1b[0m\r\n`);
                            this.emit('data', Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                        }
                    }
                } catch (e) {
                    this.emit('error', e);
                }
            }
            // 只要引擎调用 write，直接不加掩饰地发给 VPS！
            write(chunk, encoding, callback) {
                if (typeof encoding === 'function') callback = encoding;
                server.send(`\x1b[90m[TCP-OUT] 发送 ${chunk.length} 字节\x1b[0m\r\n`);
                
                this.writer.write(chunk).then(() => {
                    if (callback) callback();
                }).catch(e => {
                    this.emit('error', e);
                });
                return true; // 欺骗引擎：我的缓冲区永远是空的，随便发！
            }
            end(data, encoding, callback) {
                if (data) this.write(data, encoding);
                this.writer.close().catch(()=>{});
                if (callback) callback();
                this.emit('end');
                this.emit('close');
            }
            destroy(err) {
                this.writer.close().catch(()=>{});
                this.reader.cancel().catch(()=>{});
                if (err) this.emit('error', err);
                this.emit('close');
            }
            // 补齐套接字基础方法，防止报错
            setTimeout() { return this; }
            setNoDelay() { return this; }
            setKeepAlive() { return this; }
            ref() { return this; }
            unref() { return this; }
            pause() { return this; }
            resume() { return this; }
        }

        const bridge = new FakeSocket();
        creds.sock = bridge;

        // 强行发令：告诉引擎一切就绪，立刻开始握手！
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
