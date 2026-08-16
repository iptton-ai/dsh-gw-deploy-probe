// 终端半块字符二维码(与 Rust 版 admin_qr_handler 渲染一致):
// 四周 2 模块静区、上下半块合并(█▀▄ )、ANSI 黑字白底包裹 —— 终端主题无关,
// 手机相机看到的始终是标准极性(黑模块/白底)。Mac 侧 pair.mjs 零依赖打印用。
import QRCode from "qrcode";

export function renderTerminalQr(text: string): { modules: number; qr: string } {
  const code = QRCode.create(text, { errorCorrectionLevel: "M" });
  const width: number = code.modules.size;
  const data: Uint8Array = code.modules.data;
  const total = width + 4; // 四周 2 模块静区
  const isDark = (x: number, y: number): boolean => {
    const [mx, my] = [x - 2, y - 2];
    if (mx < 0 || my < 0 || mx >= width || my >= width) return false;
    return data[my * width + mx] !== 0;
  };
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = "";
    for (let x = 0; x < total; x++) {
      const top = isDark(x, y);
      const bottom = y + 1 < total && isDark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return { modules: width, qr: `\x1b[30;47m${lines.join("\n")}\x1b[0m` };
}
