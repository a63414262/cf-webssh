export async function onRequest(context) {
  const { request } = context;
  let url = new URL(request.url);
  
  // 核心：只替换为目标域名，绝不多管闲事修改路径！
  url.hostname = 'ssh-kj123.koyeb.app';
  
  // 100% 还原你找到的成功代码：原封不动地打包原始的 WebSocket 握手请求
  let new_request = new Request(url, request);
  
  // 发射！
  return fetch(new_request);
}
