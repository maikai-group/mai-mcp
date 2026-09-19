// Byte-accurate line streaming — the watermark's foundation. Offsets returned
// here are true byte positions (usable as createReadStream({ start })), which
// readline cannot provide. Splits on \n; strips a trailing \r from the decoded
// text while counting it in offsets. Multi-byte UTF-8 is safe because only
// complete lines are decoded.
import fs from 'node:fs';

export interface OffsetLine {
  /** Byte offset of this line's first byte in the file. */
  offset: number;
  /** Decoded line content without the trailing newline (or \r\n). */
  text: string;
}

export async function* readLinesWithOffsets(
  filePath: string,
  fromOffset = 0
): AsyncGenerator<OffsetLine> {
  const stream = fs.createReadStream(filePath, { start: fromOffset });
  let carry: Buffer = Buffer.alloc(0);
  let offset = fromOffset;
  for await (const chunk of stream) {
    carry = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
    let nl: number;
    while ((nl = carry.indexOf(0x0a)) !== -1) {
      const lineBytes = nl + 1; // include the \n in the offset advance
      let end = nl;
      if (end > 0 && carry[end - 1] === 0x0d) end--; // \r\n → strip \r from text only
      yield { offset, text: carry.subarray(0, end).toString('utf8') };
      offset += lineBytes;
      carry = carry.subarray(lineBytes);
    }
  }
  if (carry.length > 0) {
    let end = carry.length;
    if (carry[end - 1] === 0x0d) end--;
    yield { offset, text: carry.subarray(0, end).toString('utf8') };
  }
}
