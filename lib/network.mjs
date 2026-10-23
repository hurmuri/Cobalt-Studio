import os from 'node:os';
import dgram from 'node:dgram';
import { isIP } from 'node:net';

export function lanAddresses(interfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isUsableIPv4(address.address)) continue;
      if (result.some((item) => item.address === address.address)) continue;
      result.push({ name, address: address.address });
    }
  }
  return result;
}

export async function preferredLanAddress() {
  const addresses = lanAddresses();
  // Prefer the adapter selected by the default IPv4 route. Virtual adapters
  // such as VMware host-only networks also use 192.168.x.x and must not win.
  const routed = await defaultRouteAddress();
  return selectAccessAddresses(addresses, routed)[0] || null;
}

function isVirtualAdapter(name) {
  return /vmware|virtualbox|vethernet|hyper-v|wsl|docker|loopback|tailscale|zerotier|\bvpn\b|\btun\b|\btap\b/i.test(name);
}

function isUsableIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first > 0 && first !== 127 && first < 224 && !(first === 169 && second === 254);
}

export function selectAccessAddresses(addresses, routed) {
  const valid = addresses.filter((item) => isUsableIPv4(item.address));
  const lan = valid.filter((item) => !isVirtualAdapter(item.name));
  const preferred = lan.find((item) => item.address === routed) ||
    lan.find((item) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) || lan[0];
  const ordered = preferred ? [preferred, ...lan.filter((item) => item !== preferred)] : [];
  const tailscale = valid.filter((item) => /tailscale/i.test(item.name));
  return [...ordered.map((item) => ({ ...item, kind: 'lan' })),
    ...tailscale.map((item) => ({ ...item, kind: 'tailscale' }))]
    .filter((item, index, list) => list.findIndex((candidate) => candidate.address === item.address) === index);
}

export async function mobileAccessAddresses() {
  return selectAccessAddresses(lanAddresses(), await defaultRouteAddress());
}

async function defaultRouteAddress() {
  // A connected UDP socket does not send packets, but makes the OS choose the
  // IPv4 address for the default route. This avoids platform-specific routes.
  try {
    return await new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;
      const finish = (address) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        resolve(address);
      };
      const timer = setTimeout(() => finish(null), 500);
      socket.once('error', () => finish(null));
      socket.connect(53, '8.8.8.8', () => {
        const address = socket.address().address;
        finish(address !== '0.0.0.0' ? address : null);
      });
    });
  } catch {
    return null;
  }
}

export async function advertisedOrigin(req, config) {
  if (config.publicOrigin) return config.publicOrigin.replace(/\/+$/, '');
  const host = String(req.headers.host || '').split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    return `http://${req.headers.host}`;
  }
  const lan = await preferredLanAddress();
  return `http://${lan?.address || '127.0.0.1'}:${config.port}`;
}
