/** Loop until `max` or EOF — a single read() can return short on network filesystems. */
export async function readCappedBytes(
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>,
  max: number,
): Promise<Uint8Array> {
  const buf = new Uint8Array(max);
  let got = 0;
  while (got < max) {
    const { bytesRead } = await read(buf, got, max - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}
