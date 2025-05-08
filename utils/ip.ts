import fetch from 'node-fetch';
import { CONFIG } from '../config.ts';

export function getClientIp(req: any): string {
  // Express下获取真实IP
  return (
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    ''
  );
}

function isIPv6(ip: string): boolean {
  return ip.includes(':');
}

const IP_APIS = [
  { name: 'taobao', url: ip => `https://ip.taobao.com/outGetIpInfo?ip=${ip}&accessKey=alibaba` },
  { name: 'meituan', url: ip => `https://apimobile.meituan.com/locate/v2/ip/loc?rgeo=true&ip=${ip}` },
  { name: 'bilibili', url: ip => `https://api.live.bilibili.com/ip_service/v1/ip_service/get_ip_addr?ip=${ip}` },
  { name: 'ipinfo', url: ip => `https://ipinfo.io/${ip}/json` },
];

function parseApiResult(apiName: string, data: any): any {
  if (apiName === 'taobao') {
    if (data && data.data) {
      return {
        country: data.data.country,
        region: data.data.region,
        city: data.data.city,
        isp: data.data.isp,
        fromwhere: 'taobao',
        raw: data
      };
    }
  } else if (apiName === 'meituan') {
    if (data && data.data && data.data.rgeo) {
      return {
        country: data.data.rgeo.country,
        region: data.data.rgeo.province,
        city: data.data.rgeo.city,
        isp: data.data.rgeo.isp,
        fromwhere: 'meituan',
        raw: data
      };
    }
  } else if (apiName === 'bilibili') {
    if (data && data.data && data.data.country) {
      return {
        country: data.data.country,
        region: data.data.province,
        city: data.data.city,
        isp: data.data.isp,
        fromwhere: 'bilibili',
        raw: data
      };
    }
  } else if (apiName === 'ipinfo') {
    if (data && (data.country || data.region || data.city)) {
      return {
        country: data.country,
        region: data.region,
        city: data.city,
        org: data.org,
        fromwhere: 'ipinfo',
        raw: data
      };
    }
  }
  return null;
}

export async function getIpInfo(ip: string, geo?: string) {
  // IPv6只用bilibili和ipinfo
  const is6 = isIPv6(ip);
  let apis = IP_APIS;
  if (is6) {
    apis = IP_APIS.filter(api => api.name === 'bilibili' || api.name === 'ipinfo');
  }
  if (geo) {
    const api = apis.find(api => api.name === geo);
    if (!api) return {};
    try {
      const res = await fetch(api.url(ip));
      if (!res.ok) return {};
      const data = await res.json();
      return parseApiResult(api.name, data) || {};
    } catch {
      return {};
    }
  } else {
    // 默认全部API都查，返回数组
    const results = [];
    for (const api of apis) {
      try {
        const res = await fetch(api.url(ip));
        if (!res.ok) continue;
        const data = await res.json();
        const parsed = parseApiResult(api.name, data);
        if (parsed) results.push(parsed as never);
      } catch {}
    }
    return results;
  }
} 