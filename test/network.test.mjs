import assert from 'node:assert/strict';
import { lanAddresses, selectAccessAddresses } from '../lib/network.mjs';

const entries = [
  {name: 'VMware Network Adapter VMnet8', address: '192.168.193.1'},
  {name: 'Tailscale', address: '100.64.0.8'},
  {name: 'Wi-Fi', address: '192.168.1.20'},
  {name: 'Ethernet', address: '10.0.0.9'},
  {name: 'Ethernet 2', address: '169.254.2.4'},
  {name: 'Broken', address: '0.0.0.0'},
];
const selected = selectAccessAddresses(entries, '10.0.0.9');
assert.deepEqual(selected.map((item) => item.address), ['10.0.0.9', '192.168.1.20', '100.64.0.8']);
assert.equal(selected.at(-1).kind, 'tailscale');
assert.equal(selectAccessAddresses(entries, '100.64.0.8')[0].address, '192.168.1.20');
assert.equal(selectAccessAddresses(entries, '192.168.193.1')[0].address, '192.168.1.20');
assert.deepEqual(selectAccessAddresses([entries[0]], null), []);
assert.equal(selectAccessAddresses([entries[1]], null)[0].kind, 'tailscale');
const interfaces = Object.fromEntries(entries.map((entry) => [entry.name, [{family: 'IPv4', internal: false, address: entry.address}]]));
interfaces['Loopback'] = [{family: 'IPv4', internal: false, address: '127.0.0.2'}];
interfaces['Duplicate'] = [{family: 'IPv4', internal: false, address: '192.168.1.20'}];
interfaces['IPv6'] = [{family: 'IPv6', internal: false, address: '::1'}];
assert.equal(lanAddresses(interfaces).length, 4);
console.log('PASS  default route prefers physical IPv4; Tailscale is selectable; virtual and unusable addresses are excluded');
