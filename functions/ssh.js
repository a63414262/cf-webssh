export async function onRequest(context) {
  const { request } = context;
  let url = new URL(request.url);
  
  // 1. 强制将目标域名替换为你的 Koyeb 后端
  url.hostname = 'ssh-kj123.koyeb.app';
  
  // 2. 致命核心修复：强行抹除 Pages 自带的 '/ssh' 路径，将其改回根目录 '/'
  // 这样 Koyeb 接收到的就是纯净的根路径 WebSocket 请求
  url.pathname = '/';
  
  // 3. 完美继承原请求的所有 Headers (包括 Upgrade: websocket)
  let new_request = new Request(url, request);
  
  // 4. 发射代理请求！
  return fetch(new_request);
}
