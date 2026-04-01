export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // 将目标域名强制替换为你的 Koyeb 后端
  url.hostname = 'ssh-kj123.koyeb.app';
  
  // 确保使用根路径，防止 Koyeb 找不到路由
  url.pathname = '/';
  
  // 克隆原有的请求（完美保留 WebSocket 的所有握手协议和 Headers）
  const new_request = new Request(url.toString(), request);
  
  // Cloudflare 服务器出面，代你向 Koyeb 发起真实连接
  return fetch(new_request);
}
