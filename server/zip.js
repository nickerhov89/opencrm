import {crc32, deflateRawSync, inflateRawSync} from 'node:zlib';

// A small ZIP reader and writer for plugin packages: stored and deflated entries, no ZIP64,
// no encryption. Entry names are checked so an archive cannot write outside its folder.

export class ZipError extends Error {}
const bad = message => { throw new ZipError(message); };

export function safeEntryName(name) {
  const clean = String(name).replace(/\\/g, '/');
  if (!clean || clean.length > 300 || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.includes('\0')) return null;
  const parts = clean.split('/').filter((part, index, list) => part !== '' || index === list.length - 1);
  if (parts.some(part => part === '..' || part === '.')) return null;
  return parts.join('/');
}

// Returns [{name, data}] for files; folders are skipped.
export function readZip(buffer, {maxFiles = 500, maxTotal = 50 * 1024 * 1024, maxFile = 20 * 1024 * 1024} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) bad('Файл не похож на ZIP-архив');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) bad('Файл не похож на ZIP-архив');
  const count = buffer.readUInt16LE(end + 10), dirSize = buffer.readUInt32LE(end + 12), dirOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) bad('Архивы ZIP64 не поддерживаются');
  if (count > maxFiles) bad(`В архиве больше ${maxFiles} файлов`);
  if (dirOffset + dirSize > buffer.length) bad('Архив повреждён');
  const files = [], seen = new Set();
  let total = 0, at = dirOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) bad('Архив повреждён');
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10);
    const checksum = buffer.readUInt32LE(at + 16), packed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    const madeBy = buffer.readUInt16LE(at + 4) >> 8, attributes = buffer.readUInt32LE(at + 38), localOffset = buffer.readUInt32LE(at + 42);
    const rawName = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (rawName.endsWith('/') || rawName.endsWith('\\')) continue;
    const name = safeEntryName(rawName);
    if (!name) bad(`Недопустимое имя файла в архиве: ${rawName.slice(0, 100)}`);
    if (seen.has(name)) bad(`Файл повторяется в архиве: ${name}`);
    seen.add(name);
    if (flags & 1) bad('Зашифрованные архивы не поддерживаются');
    // Unix symlinks (made on Unix, file type 0o120000) are refused.
    if (madeBy === 3 && ((attributes >>> 16) & 0o170000) === 0o120000) bad(`Ссылки в архиве не поддерживаются: ${name}`);
    if (size > maxFile) bad(`Файл слишком большой: ${name}`);
    total += size;
    if (total > maxTotal) bad('Распакованный архив слишком большой');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) bad('Архив повреждён');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + packed > buffer.length) bad('Архив повреждён');
    const raw = buffer.subarray(start, start + packed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, {maxOutputLength: Math.max(size, 1)}); } catch { bad(`Не удалось распаковать: ${name}`); }
    } else bad(`Неподдерживаемый способ сжатия в файле ${name}`);
    if (data.length !== size || crc32(data) !== checksum) bad(`Контрольная сумма не совпала: ${name}`);
    files.push({name, data});
  }
  return files;
}

// files: [{name, data}] → ZIP buffer.
export function writeZip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const packed = deflateRawSync(data), useDeflate = packed.length < data.length, body = useDeflate ? packed : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt32LE(0, 12); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
