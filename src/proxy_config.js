export function getProxyConfig() {
  let config;
  if (process.env.PROXY_URL) {
    try {
      const url = new URL(process.env.PROXY_URL);
      const type = url.protocol.slice(0, -1);
      config = {
        type, host: url.hostname,
        port: Number(url.port || ({ http: 80, https: 443, socks4: 1080, socks5: 1080 })[type]),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    } catch {
      throw new Error("PROXY_URL 格式无效");
    }
  } else if (process.env.PROXY_HOST || process.env.PROXY_PORT) {
    config = {
      type: process.env.PROXY_TYPE || "http",
      host: process.env.PROXY_HOST,
      port: Number(process.env.PROXY_PORT),
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    };
  } else {
    return null;
  }
  if (!["http", "https", "socks4", "socks5"].includes(config.type) || !config.host ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("代理协议、主机或端口无效");
  }
  return config;
}

export function getPuppeteerProxyArgs(config) {
  return config ? [`--proxy-server=${config.type}://${config.host}:${config.port}`] : [];
}
