// 最小 ZIP 读取器：零依赖，只用 node:zlib。
// 只做校验需要的事：列条目、拿文件名、拿解压后的内容。
// 不支持 zip64（2GB 以上 / 65535 个条目以上）——小工具包不可能到这个量级，遇到直接报错而不是猜。

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LFH = 0x04034b50;

export function isZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

export function readZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾记录（EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('该 zip 使用 zip64 格式，暂不支持（小工具包不会到 2GB，请检查是否压错了文件）');
  }

  const entries = [];
  let off = cdOff;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length) throw new Error('zip 中央目录越界，文件可能损坏');
    if (buf.readUInt32LE(off) !== SIG_CD) throw new Error('zip 中央目录损坏（第 ' + (i + 1) + ' 条）');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lfhOff = buf.readUInt32LE(off + 42);
    const rawName = buf.subarray(off + 46, off + 46 + nameLen);
    // 通用标志位 11 = 文件名是 UTF-8；没置位时按 UTF-8 解，失败再退回二进制安全字符串
    const name = flags & 0x800 ? rawName.toString('utf8') : decodeLoose(rawName);

    let data = null;
    if (!name.endsWith('/')) {
      if (lfhOff + 30 > buf.length || buf.readUInt32LE(lfhOff) !== SIG_LFH) {
        throw new Error('zip 本地文件头损坏：' + name);
      }
      const lNameLen = buf.readUInt16LE(lfhOff + 26);
      const lExtraLen = buf.readUInt16LE(lfhOff + 28);
      const start = lfhOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else data = null; // 其他压缩方法（bzip2/lzma 等）小工具包里不该出现
    }
    entries.push({ name, size: uncompSize, method, data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function decodeLoose(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  // 老工具打出来的中文名常是 GBK；这里只为把文件名显示对，校验逻辑不依赖它
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}
