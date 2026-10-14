declare module "lzma" {
  export function decompress(input: Uint8Array | number[]): number[] | string;
  export function compress(input: Uint8Array | number[], mode?: number): number[];
}
