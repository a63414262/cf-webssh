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

        server.send('\x1b[33m[System]\x1b[0m 发起底层 TCP 直连...\r\n');

        const tcpSocket = connect({ hostname: creds.host, port: parseInt(creds.port) });
        try {
            await tcpSocket.opened; 
        } catch (tcpErr) {
            server.send(`\r\n\x1b[31m[System] TCP 连接失败: ${tcpErr.message}\x1b[0m\r\n`);
            return server.close();
        }

        server.send('\x1b[32m[System]\x1b[0m TCP 已通，注入事件驱动型无阻碍网卡...\r\n');

        // 【终极修复】：彻底抛弃 CF 损坏的 Duplex 流，纯手工接管收发事件！
        class EventSocket extends EventEmitter {
            constructor() {
                super();
                this.readable = true;
                this.writable = true;
                this.readyState = 'open'; // 告诉引擎通道大开
                this.writer = tcpSocket.writable.getWriter();
                this.reader = tcpSocket.readable.getReader();
                this.pump();
            }

            // 暴力抽水机：收到数据一秒不留，立刻砸给引擎
            async pump() {
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
                            // 直接发射事件，彻底绕过所有可能卡死的缓冲区
                            this.emit('data', Buffer.from(value));
                        }
                    }
                } catch (e) {
                    this.emit('error', e);
                }
            }

            // 暴力发射器：引擎给的数据，不经过任何缓存，直接砸向 VPS
            write(chunk, encoding, cb) {
                if (typeof encoding === 'function') cb = encoding;
                server.send(`\x1b[90m[TCP-OUT] 发送 ${chunk.length} 字节\x1b[0m\r\n`);
                
                this.writer.write(new Uint8Array(chunk)).then(() => {
                    if (cb) cb();
                }).catch(e => {
                    this.emit('error', e);
                });
                return true; 
            }

            end(chunk, encoding, cb) {
                if (chunk) this.write(chunk, encoding);
                this.writer.close().catch(()=>{});
                if (cb) cb();
                this.emit('end');
            }

            destroy(err) {
                this.writer.close().catch(()=>{});
                this.reader.cancel().catch(()=>{});
                if (err) this.emit('error', err);
                this.emit('close');
            }

            // 完美伪装原生管道特性
            pipe(dest) {
                this.on('data', chunk => dest.write(chunk));
                return dest;
            }

            unpipe() {} pause() {} resume() {} cork() {} uncork() {} setEncoding() {}
            setTimeout() { return this; } setNoDelay() { return this; }
            setKeepAlive() { return this; } ref() { return this; } unref() { return this; }
        }

        const sock = new EventSocket();
        creds.sock = sock;

        sshClient.on('ready', () => {
          server.send('\r\n\x1b[32m[System]\x1b[0m 密钥交换成功！正在请求 Shell...\r\n');
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

        // 强制触发动机，拒绝等待
        setTimeout(() => sock.emit('connect'), 50);

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
