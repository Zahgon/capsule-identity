// Drives the REAL compiled Rust capsule (wasm32-unknown-unknown core module)
// through `astrid-hook-trigger`, producing the canonical observation trace.

import fs from 'node:fs';
import {
  createWorld, snapshot, FS_ERR, KV_ERR, IPC_ERR, LOG_LEVELS, debugName,
} from './world.mjs';

const ALIGN = 4;

export async function runScenario(wasmPath, scenario) {
  const world = createWorld(scenario);
  let memory = null;
  let realloc = null;

  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  const readStr = (ptr, len) => Buffer.from(u8().slice(ptr, ptr + len)).toString('utf8');
  const readBytes = (ptr, len) => Buffer.from(u8().slice(ptr, ptr + len));

  const alloc = (bytes) => {
    if (bytes.length === 0) return ALIGN; // non-null dangling pointer
    const ptr = realloc(0, 0, ALIGN, bytes.length);
    u8().set(bytes, ptr);
    return ptr;
  };
  const allocStr = (s) => alloc(Buffer.from(s, 'utf8'));

  // ---- canonical `result<...>` writers -------------------------------------
  // Every `error-code` in these packages is a variant whose only payload case
  // is `unknown(string)`, so the flat layout is:
  //   +0 outer result discriminant
  //   +4 error discriminant (or ok payload word 0)
  //   +8/+12 string ptr/len (or ok payload words 1/2)
  const writeErr = (ret, table, spec) => {
    const code = typeof spec === 'string' ? spec : spec.code;
    const idx = table.indexOf(code);
    if (idx < 0) throw new Error(`unknown error code '${code}'`);
    const d = dv();
    d.setInt32(ret + 0, 1, true);
    d.setInt32(ret + 4, idx, true);
    if (code === 'unknown') {
      const p = allocStr(spec.detail ?? '');
      dv().setInt32(ret + 8, p, true);
      dv().setInt32(ret + 12, Buffer.byteLength(spec.detail ?? '', 'utf8'), true);
    }
  };
  const writeOkList = (ret, buf) => {          // result<list<u8>, e>
    const p = alloc(buf);
    const d = dv();
    d.setInt32(ret + 0, 0, true);
    d.setInt32(ret + 4, p, true);
    d.setInt32(ret + 8, buf.length, true);
  };
  const writeOkUnit = (ret) => { dv().setInt32(ret + 0, 0, true); };
  const writeOkOptList = (ret, buf) => {       // result<option<list<u8>>, e>
    const d0 = dv();
    d0.setInt32(ret + 0, 0, true);
    if (buf === undefined) { d0.setInt32(ret + 4, 0, true); return; }
    const p = alloc(buf);
    const d = dv();
    d.setInt32(ret + 4, 1, true);
    d.setInt32(ret + 8, p, true);
    d.setInt32(ret + 12, buf.length, true);
  };

  const imports = {
    'astrid:kv/host@1.0.0': {
      'kv-get': (kp, kl, ret) => {
        const key = readStr(kp, kl);
        const e = world.kvErrors[key];
        if (e && (e.op ?? 'get') === 'get') return writeErr(ret, KV_ERR, e);
        writeOkOptList(ret, world.kv.get(key));
      },
      'kv-set': (kp, kl, vp, vl, ret) => {
        const key = readStr(kp, kl);
        const e = world.kvErrors[key];
        if (e && e.op === 'set') return writeErr(ret, KV_ERR, e);
        world.kv.set(key, readBytes(vp, vl));
        writeOkUnit(ret);
      },
    },
    'astrid:fs/host@1.0.0': {
      'read-file': (pp, pl, ret) => {
        const path = readStr(pp, pl);
        const e = world.fsErrors[path];
        if (e && (e.op ?? 'read') === 'read') return writeErr(ret, FS_ERR, e);
        const f = world.files.get(path);
        if (f === undefined) return writeErr(ret, FS_ERR, 'not-found');
        writeOkList(ret, f);
      },
      'write-file': (pp, pl, cp, cl, ret) => {
        const path = readStr(pp, pl);
        const e = world.fsErrors[path];
        if (e && e.op === 'write') return writeErr(ret, FS_ERR, e);
        world.files.set(path, readBytes(cp, cl));
        writeOkUnit(ret);
      },
    },
    'astrid:ipc/host@1.0.0': {
      publish: (tp, tl, pp, pl, ret) => {
        const topic = readStr(tp, tl);
        const payload = readStr(pp, pl);
        const e = world.ipcErrors[topic];
        if (e) { world.publishes.push({ topic, payload, failed: true }); return writeErr(ret, IPC_ERR, e); }
        world.publishes.push({ topic, payload });
        writeOkUnit(ret);
      },
    },
    'astrid:sys/host@1.0.0': {
      log: (level, mp, ml) => {
        world.logs.push({ level: LOG_LEVELS[level] ?? `?${level}`, message: readStr(mp, ml) });
      },
      'random-bytes': (len, ret) => {
        writeOkList(ret, Buffer.alloc(Number(len), world.randomByte));
      },
    },
  };

  const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const inst = await WebAssembly.instantiate(mod, imports);
  memory = inst.exports.memory;
  realloc = inst.exports.cabi_realloc;

  const results = [];
  for (const call of scenario.calls ?? []) {
    const payload = call.payloadB64 !== undefined
      ? Buffer.from(call.payloadB64, 'base64')
      : Buffer.from(call.payload ?? '', 'utf8');
    const ap = allocStr(call.action);
    const al = Buffer.byteLength(call.action, 'utf8');
    const pp = alloc(payload);

    const logsBefore = world.logs.length;
    const pubsBefore = world.publishes.length;

    let ret;
    try {
      ret = inst.exports['astrid-hook-trigger'](ap, al, pp, payload.length);
    } catch (err) {
      results.push({ action: call.action, trapped: String(err && err.message) });
      continue;
    }

    // capsule-result { action: string, data: option<string> }
    const d = dv();
    const actPtr = d.getInt32(ret + 0, true);
    const actLen = d.getInt32(ret + 4, true);
    const hasData = d.getInt32(ret + 8, true);
    const dataPtr = d.getInt32(ret + 12, true);
    const dataLen = d.getInt32(ret + 16, true);
    const out = {
      action: readStr(actPtr, actLen),
      data: hasData ? readStr(dataPtr, dataLen) : null,
    };
    inst.exports['cabi_post_astrid-hook-trigger'](ret);

    results.push({
      action: call.action,
      result: out,
      publishes: world.publishes.slice(pubsBefore),
      logs: world.logs.slice(logsBefore),
    });
  }

  return { calls: results, world: snapshot(world) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [wasmPath, scenarioPath] = process.argv.slice(2);
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  console.log(JSON.stringify(await runScenario(wasmPath, scenario), null, 2));
}
