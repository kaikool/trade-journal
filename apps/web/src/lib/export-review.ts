import { readVizTokens } from "@/components/charts/tokens";

export interface ReviewDocument {
  title: string;
  subtitle?: string;
  lines: string[];
}
export interface ExportFile {
  blob: Blob;
  filename: string;
}
const filename = (title: string) =>
  title.replace(/[^a-z0-9_-]/gi, "-").slice(0, 100) || "journal-review";

export async function exportPng(doc: ReviewDocument) {
  await document.fonts.ready;
  // Colors come from the same resolved design tokens the charts paint with,
  // so an exported card matches the active theme.
  const t = readVizTokens();
  const canvas = document.createElement("canvas"),
    ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable in this browser.");
  canvas.width = 1200;
  ctx.font = "24px Arial";
  const lines: string[] = [];
  for (const source of doc.lines.flatMap((s) => s.split("\n"))) {
    let line = "";
    for (const char of source) {
      if (ctx.measureText(line + char).width > 1040 && line) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    lines.push(line);
  }
  const pages = Math.max(1, Math.ceil(lines.length / 55));
  const files: ExportFile[] = [];
  // A long review is exported as numbered cards, without clipping its content.
  for (let i = 0; i < pages; i++) {
    const chunk = lines.slice(i * 55, (i + 1) * 55);
    canvas.height = Math.max(600, 300 + chunk.length * 38);
    ctx.fillStyle = t.surface;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = t.brand;
    ctx.fillRect(0, 0, 1200, 8);
    ctx.fillStyle = t.inkMuted;
    ctx.font = "22px Arial";
    ctx.fillText(`TRADE JOURNAL${pages > 1 ? ` · ${i + 1}/${pages}` : ""}`, 80, 70);
    ctx.fillStyle = t.foreground;
    ctx.font = "bold 38px Arial";
    ctx.fillText(doc.title, 80, 130, 1040);
    ctx.fillStyle = t.inkMuted;
    ctx.font = "20px Arial";
    ctx.fillText(doc.subtitle ?? "", 80, 174, 1040);
    ctx.fillStyle = t.foreground;
    ctx.font = "24px Arial";
    chunk.forEach((line, j) => ctx.fillText(line, 80, 244 + j * 38));
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Image export failed."))),
        "image/png",
      ),
    );
    files.push({ blob, filename: `${filename(doc.title)}${pages > 1 ? `-${i + 1}` : ""}.png` });
  }
  return files;
}
