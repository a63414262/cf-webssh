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
        
        server.send('\x1b[32m[System]\x1b[0m TCP 隧道已完全打通，引擎开始交换密钥...\r\n');

        const writer = tcpSocket.writable.getWriter();
        const reader = tcpSocket.readable.getReader();

        // 打造无缝流转接器
        class CFBridgeStream extends Duplex {
          constructor() {
            super();
            // 伪装成已经打开的网卡套接字
            this.readyState = 'open';
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
                // 【终极黑魔法 2】：将 Web 原生字节组强转为 Node.js Buffer！
                // 这一行解决了 ssh2 无法解析数据导致的静默崩溃和超时问题！
                this.push(Buffer.from(value));
              }
            } catch (e) {
              this.destroy(e);
            }
          }
          
          _read(size) { /* 占位符，符合 Duplex 流的死板规范 */ }
          
          _write(chunk, encoding, callback) {
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

          // 伪装一些底层的原生网络方法，防止 ssh2 调用时报错
          setTimeout() { return this; }
          setNoDelay() { return this; }
          setKeepAlive() { return this; }
          ref() { return this; }
          unref() { return this; }
        }

        creds.sock = new CFBridgeStream();

        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              server.send('\r\n\x1b[31mShell 申请失败\x1b[0m\r\n');
              return server.close();
            }
            sshStream = stream;
            server.send('\r\n\x1b[32m[System]\x1b[0m 🚀 成功打穿 CF 沙盒！您已获取最高控制权限。\r\n');
            
            stream.on('data', (data) => server.send(data.toString('utf8')));
            stream.on('close', () => server.close());
          });
        }).on('error', (err) => {
          server.send(`\r\n\x1b[31m[System] SSH 引擎被踢出:\x1b[0m ${err.message}\r\n`);
          server.send('\x1b[33m[排错提示] 如果提示算法不匹配，请确保使用的是密码或普通 RSA 私钥。\x1b[0m\r\n');
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
