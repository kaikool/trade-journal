declare module "lzma-purejs-requirejs" {
  export function decompressFile(
    input: Uint8Array,
    output?: { writeByte(byte: number): void },
  ): unknown;
  export function compressFile(input: Uint8Array): Uint8Array;
}
