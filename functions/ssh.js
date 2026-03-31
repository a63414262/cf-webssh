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
        
        server.send('\x1b[32m[System]\x1b[0m TCP 隧道打通，注入原生流实例化对象...\r\n');

        const writer = tcpSocket.writable.getWriter();
        const reader = tcpSocket.readable.getReader();

        // 【终极核心】：直接实例化 Node.js 原生的 Duplex，彻底避免 ES6 class 继承导致的内部状态机崩溃！
        const bridge = new Duplex({
          read(size) {}, // 符合规范的空读取
          write(chunk, encoding, callback) {
            server.send(`\x1b[90m[TCP-OUT] 发送 ${chunk.length} 字节\x1b[0m\r\n`);
            // 确保发出的数据是纯净的字节流
            writer.write(new Uint8Array(chunk)).then(() => callback()).catch(callback);
          },
          destroy(err, callback) {
            writer.close().catch(()=>{});
            reader.cancel().catch(()=>{});
            callback(err);
          }
        });

        // 欺骗引擎：模拟 net.Socket 的所有必备属性
        bridge.readyState = 'open';
        bridge.connecting = false;
        bridge.remoteAddress = creds.host;
        bridge.remotePort = creds.port;
        bridge.setTimeout = function() { return this; };
        bridge.setNoDelay = function() { return this; };
        bridge.setKeepAlive = function() { return this; };
        bridge.ref = function() { return this; };
        bridge.unref = function() { return this; };

        // 异步抽水泵：将 CF 的数据源源不断抽进 Node.js 管道
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { 
                  bridge.push(null);
                  break; 
              }
              if (value) {
                  server.send(`\x1b[90m[TCP-IN] 收到 ${value.byteLength} 字节\x1b[0m\r\n`);
                  // 强制包装为 Node.js 原生 Buffer
                  bridge.push(Buffer.from(value));
              }
            }
          } catch (e) {
            bridge.destroy(e);
          }
        })();

        creds.sock = bridge;

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

        // 强行触发动机：发出 connect 事件，防止死等
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
