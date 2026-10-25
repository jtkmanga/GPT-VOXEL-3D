'use strict';
// Opt-in verification transport for managed sandboxes. Application code never
// imports this file. Native child exits, errors, signals, limits and Node test
// isolation remain unchanged; no failed operation is reclassified as success.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const preload = __filename;

// Node's socket-backed Writable stdio can acknowledge writes without delivering
// bytes in this sandbox. Direct descriptor writes retain the exact test output,
// including the default test runner's serialized child-process protocol.
for (const [stream, descriptor] of [[process.stdout, 1], [process.stderr, 2]]) {
  const originalWrite = stream.write.bind(stream);
  stream.write = function write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
      return originalWrite(chunk, encoding, callback);
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (!written) throw Error('Verification stdio made no forward progress');
        offset += written;
      }
    } catch (error) {
      if (callback) process.nextTick(callback, error);
      else throw error;
      return false;
    }
    if (callback) process.nextTick(callback);
    return true;
  };
}

// Keep the preload on npm/shebang children. Explicit Node arguments below also
// propagate it through the legacy runner's intentionally filtered environment.
const preloadOption = `--require ${JSON.stringify(preload)}`;
if (!(process.env.NODE_OPTIONS || '').includes(preload))
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${preloadOption}`.trim();

function nodeArguments(file, args) {
  args = args === undefined ? [] : args;
  if (!Array.isArray(args)) return args;
  if ((file === process.execPath || /^node(?:\.exe)?$/.test(path.basename(file))) &&
      !args.includes(preload)) return ['--require', preload, ...args];
  return args;
}

function inputOptions(options = {}) {
  const adapted = { ...options };
  const stdio = options.stdio === undefined || options.stdio === 'pipe'
    ? ['pipe', 'pipe', 'pipe']
    : Array.isArray(options.stdio) ? [...options.stdio] : null;
  const hasInput = options.input !== undefined && options.input !== null;
  if (!hasInput && (!stdio || ![undefined, null, 'pipe'].includes(stdio[0])))
    return { options: adapted, close() {} };
  if (!hasInput) {
    stdio[0] = 'ignore'; // Same immediate EOF as an unused, closed input pipe.
    adapted.stdio = stdio;
    return { options: adapted, close() {} };
  }
  // Preserve binary input exactly (Git tar extraction and esbuild requests).
  // A regular descriptor avoids the failing synchronous input-socket setup.
  const bytes = typeof options.input === 'string'
    ? Buffer.from(options.input, options.encoding)
    : ArrayBuffer.isView(options.input)
      ? Buffer.from(options.input.buffer, options.input.byteOffset, options.input.byteLength)
      : null;
  if (!bytes) throw new TypeError('Verification subprocess input must be a string or ArrayBuffer view');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-verification-input-'));
  fs.chmodSync(directory, 0o700);
  const input = path.join(directory, 'stdin');
  let descriptor;
  try {
    fs.writeFileSync(input, bytes, { mode: 0o600 });
    descriptor = fs.openSync(input, 'r');
    const descriptors = stdio || [options.stdio, options.stdio, options.stdio];
    descriptors[0] = descriptor;
    adapted.stdio = descriptors;
    delete adapted.input;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { options: adapted, close() {
    fs.closeSync(descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

for (const method of ['spawnSync', 'execFileSync']) {
  const original = childProcess[method];
  childProcess[method] = function verifiedSubprocess(file, args, options) {
    if (args !== undefined && !Array.isArray(args)) { options = args; args = undefined; }
    const input = inputOptions(options);
    try { return original.call(childProcess, file, nodeArguments(file, args), input.options); }
    finally { input.close(); }
  };
}
const originalExecSync = childProcess.execSync;
childProcess.execSync = function verifiedShell(command, options) {
  const input = inputOptions(options);
  try { return originalExecSync.call(childProcess, command, input.options); }
  finally { input.close(); }
};
syncBuiltinESMExports();
