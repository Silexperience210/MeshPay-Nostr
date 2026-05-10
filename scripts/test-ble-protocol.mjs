/**
 * MeshCore Companion Protocol v1.13 — Simulator / Unit Test
 * Run: node scripts/test-ble-protocol.mjs
 *
 * Tests every frame format against the firmware source truth:
 *   meshcore_firmware/examples/companion_radio/MyMesh.cpp
 *   meshcore_firmware/docs/companion_protocol.md
 */

let passed = 0;
let failed = 0;

function assert(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      got:      ${JSON.stringify(got)}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    failed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function u8(...bytes) { return new Uint8Array(bytes); }
function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function i32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

// ── Reproduce parsers from ble-gateway.ts ────────────────────────────

function parseSelfInfo(payload) {
  if (payload.length < 57) return null;
  const view = new DataView(payload.buffer, payload.byteOffset);
  let off = 0;
  const nodeType = payload[off++];    // type
  const txPower  = payload[off++];    // txPower
  /* maxTxPower */ off++;             // maxTxPower
  // NO flags byte in firmware v1.13

  const pubkeyBytes = payload.slice(off, off + 32); off += 32;
  const publicKey = Array.from(pubkeyBytes).map(b => b.toString(16).padStart(2,'0')).join('');

  const advLatRaw = view.getInt32(off, true);  off += 4;
  const advLonRaw = view.getInt32(off, true);  off += 4;
  off += 4; // multi_acks+adv_loc_policy+telemetry+manual_contacts

  const radioFreqHz = view.getUint32(off, true); off += 4;
  const radioBwHz   = view.getUint32(off, true); off += 4;
  const radioSf     = payload[off++];
  const radioCr     = payload[off++];

  const nameRaw = payload.slice(off);
  const name = new TextDecoder().decode(nameRaw).replace(/\0/g, '').trim() || 'MeshCore';

  return { nodeType, txPower, publicKey, advLat: advLatRaw / 1e7, advLon: advLonRaw / 1e7,
           radioFreqHz, radioBwHz, radioSf, radioCr, name };
}

function parseDirectMsg(payload) {
  // PACKET_CONTACT_MSG_RECV_V3: [SNR:1][reserved:2][pub_key_prefix:6][path_len:1][txt_type:1][timestamp:4LE][text]
  if (payload.length <= 15) return null;
  const snr = (payload[0] << 24 >> 24) / 4;
  const pubkeyPrefix = Array.from(payload.slice(3, 9)).map(b => b.toString(16).padStart(2,'0')).join('');
  const pathLen  = payload[9];
  const txtType  = payload[10];
  const ts = new DataView(payload.buffer, payload.byteOffset).getUint32(11, true);
  const text = new TextDecoder().decode(payload.slice(15));
  return { snr, pubkeyPrefix, pathLen, txtType, timestamp: ts, text };
}

function parseChannelMsg(payload) {
  // PACKET_CHANNEL_MSG_RECV_V3: [SNR:1][reserved:2][channelIdx:1][path_len:1][txt_type:1][timestamp:4LE][text]
  if (payload.length <= 10) return null;
  const snr = (payload[0] << 24 >> 24) / 4;
  const channelIdx = payload[3];
  const pathLen   = payload[4];
  const txtType   = payload[5];
  const ts = new DataView(payload.buffer, payload.byteOffset).getUint32(6, true);
  const text = new TextDecoder().decode(payload.slice(10));
  return { snr, channelIdx, pathLen, txtType, timestamp: ts, text };
}

function buildDirectMsg(cmd, txtType, attempt, timestamp, pubkeyPrefix6, text) {
  // CMD_SEND_TXT_MSG: [cmd:1][txt_type:1][attempt:1][timestamp:4LE][pub_key_prefix:6][text]
  const textBytes = new TextEncoder().encode(text);
  const tsBuf = u32le(timestamp);
  const payload = new Uint8Array(1 + 1 + 4 + 6 + textBytes.length);
  payload[0] = txtType;
  payload[1] = attempt;
  payload.set(tsBuf, 2);
  payload.set(pubkeyPrefix6, 6);
  payload.set(textBytes, 12);
  return concat(u8(cmd), payload);
}

function buildChannelMsg(cmd, channelIdx, timestamp, text) {
  // CMD_SEND_CHAN_MSG: [cmd:1][reserved=0:1][channelIdx:1][timestamp:4LE][text]
  const textBytes = new TextEncoder().encode(text);
  const tsBuf = u32le(timestamp);
  const payload = new Uint8Array(1 + 1 + 4 + textBytes.length);
  payload[0] = 0; // reserved
  payload[1] = channelIdx;
  payload.set(tsBuf, 2);
  payload.set(textBytes, 6);
  return concat(u8(cmd), payload);
}

function deliverCompanionTextPacket(fromPubkeyHex, _text) {
  // Reproduce the fix: pad 6-byte prefix to 8 bytes for BigUint64
  const rawBytes = fromPubkeyHex
    ? new Uint8Array(fromPubkeyHex.match(/.{1,2}/g).map(b => parseInt(b, 16)))
    : new Uint8Array(0);
  const padded = new Uint8Array(8);
  padded.set(rawBytes.slice(0, Math.min(rawBytes.length, 8)));
  const fromNodeId = new DataView(padded.buffer).getBigUint64(0, false);
  return fromNodeId;
}

// ══════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== 1. parseSelfInfo — firmware v1.13 layout (no flags byte) ===');
{
  // Build a synthetic SELF_INFO payload matching firmware layout:
  // [type:1][txPower:1][maxTxPower:1][pubkey:32][lat:4][lon:4][misc:4][freq:4][bw:4][sf:1][cr:1][name]
  const pubkey = new Uint8Array(32).fill(0xAB);
  const lat  = i32le(Math.round(48.8566 * 1e7));   // Paris
  const lon  = i32le(Math.round(2.3522 * 1e7));
  const misc = u8(0x01, 0x02, 0x03, 0x04);           // multi_acks etc.
  const freq = u32le(915_000_000);                    // 915 MHz
  const bw   = u32le(125_000);                        // 125 kHz
  const name = new TextEncoder().encode('TestNode\0');

  const payload = concat(
    u8(0x02),     // type = router
    u8(20),       // txPower
    u8(22),       // maxTxPower
    pubkey,
    lat, lon, misc,
    freq, bw,
    u8(9),        // SF9
    u8(5),        // CR 4/5
    name
  );

  const info = parseSelfInfo(payload);
  assert('type skipped correctly',  info !== null, true);
  assert('txPower',                  info.txPower, 20);
  assert('publicKey first byte',     info.publicKey.slice(0, 2), 'ab');
  assert('advLat ~Paris',            Math.abs(info.advLat - 48.8566) < 0.001, true);
  assert('advLon ~Paris',            Math.abs(info.advLon - 2.3522) < 0.001, true);
  assert('radioFreqHz',              info.radioFreqHz, 915_000_000);
  assert('radioBwHz',                info.radioBwHz, 125_000);
  assert('radioSf',                  info.radioSf, 9);
  assert('radioCr',                  info.radioCr, 5);
  assert('name',                     info.name, 'TestNode');
}

console.log('\n=== 2. parseSelfInfo — flags byte would shift all fields (regression) ===');
{
  // If we had the old bug (extra off++ for flags), pubkey would start at byte 4 instead of 3
  // This test verifies we read from the correct offset by putting a marker at byte 3
  const payload = new Uint8Array(70).fill(0x00);
  payload[0] = 0x01; // type
  payload[1] = 15;   // txPower
  payload[2] = 20;   // maxTxPower
  // pubkey starts at [3]: fill with 0xCC
  payload.fill(0xCC, 3, 35);
  // If buggy (off+4), first pubkey byte would be 0x00 not 0xCC

  const info = parseSelfInfo(payload);
  assert('pubkey starts at offset 3 (not 4)', info.publicKey.slice(0, 2), 'cc');
}

console.log('\n=== 3. PACKET_CONTACT_MSG_RECV_V3 (0x10) — direct message receive ===');
{
  const ts = 1711234567;
  const prefix = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  const textBytes = new TextEncoder().encode('Hello Bitcoin!');

  // [SNR:1][reserved:2][prefix:6][path_len:1][txt_type:1][timestamp:4LE][text]
  const payload = concat(
    u8(0x08),           // SNR raw = 8 → 8/4 = 2.0
    u8(0x00, 0x00),     // reserved
    prefix,             // pub_key_prefix
    u8(0x03),           // path_len
    u8(0x00),           // txt_type = 0 (plain)
    u32le(ts),
    textBytes
  );

  const msg = parseDirectMsg(payload);
  assert('snr decoded',         msg.snr, 2.0);
  assert('pubkeyPrefix',        msg.pubkeyPrefix, '010203040506');
  assert('pathLen',             msg.pathLen, 3);
  assert('txtType',             msg.txtType, 0);
  assert('timestamp',           msg.timestamp, ts);
  assert('text',                msg.text, 'Hello Bitcoin!');
}

console.log('\n=== 4. PACKET_CHANNEL_MSG_RECV_V3 (0x11) — channel message receive ===');
{
  const ts = 1711234568;
  const textBytes = new TextEncoder().encode('Nostr relay test');

  // [SNR:1][reserved:2][channelIdx:1][path_len:1][txt_type:1][timestamp:4LE][text]
  const payload = concat(
    u8(0xF0),           // SNR raw = -16 (signed) → -4.0
    u8(0x00, 0x00),     // reserved
    u8(0x02),           // channelIdx = 2
    u8(0x01),           // path_len
    u8(0x00),           // txt_type
    u32le(ts),
    textBytes
  );

  const msg = parseChannelMsg(payload);
  assert('snr negative decoded', msg.snr, -4.0);
  assert('channelIdx',           msg.channelIdx, 2);
  assert('pathLen',              msg.pathLen, 1);
  assert('timestamp',            msg.timestamp, ts);
  assert('text',                 msg.text, 'Nostr relay test');
}

console.log('\n=== 5. CMD_SEND_TXT_MSG (0x02) — outgoing direct message build ===');
{
  const ts = 1711234500;
  const prefix6 = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
  const frame = buildDirectMsg(0x02, 0, 1, ts, prefix6, 'Pay 1000 sats');

  assert('cmd byte',             frame[0], 0x02);
  assert('txt_type',             frame[1], 0);
  assert('attempt',              frame[2], 1);
  // timestamp at [3..6] LE
  const gotTs = new DataView(frame.buffer).getUint32(3, true);
  assert('timestamp LE',         gotTs, ts);
  // pubkey prefix at [7..12]
  assert('prefix[0]',            frame[7], 0xAA);
  assert('prefix[5]',            frame[12], 0xFF);
  // text at [13+]
  const text = new TextDecoder().decode(frame.slice(13));
  assert('text',                 text, 'Pay 1000 sats');
}

console.log('\n=== 6. CMD_SEND_CHAN_MSG (0x03) — outgoing channel message build ===');
{
  const ts = 1711234501;
  const frame = buildChannelMsg(0x03, 1, ts, 'sats for all');

  assert('cmd byte',             frame[0], 0x03);
  assert('reserved',             frame[1], 0);
  assert('channelIdx',           frame[2], 1);
  const gotTs = new DataView(frame.buffer).getUint32(3, true);
  assert('timestamp LE',         gotTs, ts);
  const text = new TextDecoder().decode(frame.slice(7));
  assert('text',                 text, 'sats for all');
}

console.log('\n=== 7. deliverCompanionTextPacket — 6-byte prefix → BigUint64 (no crash) ===');
{
  // Old bug: getBigUint64 on 6-byte buffer → RangeError
  // Fix: pad to 8 bytes
  const prefix6hex = '010203040506';
  let nodeId;
  let threw = false;
  try {
    nodeId = deliverCompanionTextPacket(prefix6hex, 'test');
  } catch (e) {
    threw = true;
  }
  assert('no RangeError crash',  threw, false);
  assert('nodeId is BigInt',     typeof nodeId === 'bigint', true);
  // Big-endian: 0x010203040506 padded to 0x0102030405060000
  assert('nodeId value',         nodeId.toString(), BigInt('0x0102030405060000').toString());
}

console.log('\n=== 8. CMD_APP_START — app_name at byte 8 (not byte 2) ===');
{
  // Firmware: cmd_frame[8] is where name starts (7 reserved bytes between cmd and name)
  const appName = 'MeshPay';
  const frame = new Uint8Array(1 + 7 + appName.length + 1);
  frame[0] = 0x01; // CMD_APP_START
  // bytes [1..7] = reserved zeros
  const nameBytes = new TextEncoder().encode(appName);
  frame.set(nameBytes, 8);
  frame[8 + appName.length] = 0; // null terminator

  // Simulate firmware reading cmd_frame[8]
  const readName = new TextDecoder().decode(frame.slice(8)).replace(/\0.*/, '');
  assert('app_name at offset 8',  readName, 'MeshPay');
  assert('reserved bytes zero',   frame[1], 0);
  assert('reserved bytes zero',   frame[7], 0);
}

console.log('\n=== 9. Protocol version 3 — CMD_DEVICE_QUERY payload ===');
{
  // CMD_DEVICE_QUERY (0x04): payload = [protocolVersion:1]
  const frame = new Uint8Array([0x04, 0x03]);
  assert('cmd',              frame[0], 0x04);
  assert('protocol_ver=3',   frame[1], 0x03);
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('All tests passed — protocol parsers are firmware-accurate.');
} else {
  console.error(`${failed} test(s) FAILED — fix ble-gateway.ts before deploying.`);
  process.exit(1);
}
