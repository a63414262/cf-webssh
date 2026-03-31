globalThis.__dirname = "/";
globalThis.__filename = "/";

// 回归 CF 官方真神 API
import { connect } from 'cloudflare:sockets';
// 引入必需的 Node 模块
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

        server.send('\x1b[33m[System]\x1b[0m 正在通过 CF 官方 Sockets 发起连接...\r\n');
        
        const tcpSocket = connect({ hostname: creds.host, port: parseInt(creds.port) });
        try {
            await tcpSocket.opened; 
        } catch (tcpErr) {
            server.send(`\r\n\x1b[31m[System] TCP 连接被拒 (检查IP和防火墙): ${tcpErr.message}\x1b[0m\r\n`);
            return server.close();
        }
        
        server.send('\x1b[32m[System]\x1b[0m TCP 已连通，注入完美容错双向管道...\r\n');

        const writer = tcpSocket.writable.getWriter();
        const reader = tcpSocket.readable.getReader();

        // 终极完美管道：自带类型强转和完整流状态机
        const bridge = new Duplex({
          read(size) {}, // 被动读取，保持空即可
          write(chunk, encoding, callback) {
            let buf;
            // 【核心修复】：无论引擎塞进来什么乱七八糟的类型，一律强转！
            if (Buffer.isBuffer(chunk)) {
              buf = chunk;
            } else if (typeof chunk === 'string') {
              buf = Buffer.from(chunk, encoding || 'utf8');
            } else {
              buf = Buffer.from(chunk);
            }
            
            server.send(`\x1b[90m[TCP-OUT] 引擎成功发送 ${buf.length} 字节\x1b[0m\r\n`);
            writer.write(new Uint8Array(buf)).then(() => callback()).catch(callback);
          },
          destroy(err, callback) {
            writer.close().catch(()=>{});
            reader.cancel().catch(()=>{});
            callback(err);
          }
        });

        // 强行点亮所有的准备信号灯，让 ssh2 引擎放心写入
        bridge.readyState = 'open';
        bridge.readable = true;
        bridge.writable = true;
        bridge.connecting = false;
        
        // 补齐所有的冗余套接字方法
        bridge.setTimeout = function() { return this; };
        bridge.setNoDelay = function() { return this; };
        bridge.setKeepAlive = function() { return this; };
        bridge.ref = function() { return this; };
        bridge.unref = function() { return this; };

        // 异步抽水泵：将 CF 网卡的数据抽送给引擎
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { 
                  bridge.push(null);
                  break; 
              }
              if (value) {
                  server.send(`\x1b[90m[TCP-IN] 网卡收到 ${value.byteLength} 字节\x1b[0m\r\n`);
                  // 严格包装成 Node.js 的原生 Buffer
                  bridge.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
              }
            }
          } catch (e) {
            bridge.destroy(e);
          }
        })();

        creds.sock = bridge;

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
