import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
export const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/** Widget-style rounded frame, measured in terminal columns (not string length). */
export function borderTop(title: string, info: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╭${RST}`;
  const inner = width - 2;
  const titlePart = `─ ${title} `;
  const infoPart = info ? ` ${info} ─` : "";
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(titlePart) - visibleWidth(infoPart)));
  const content = truncateToWidth(`${titlePart}${fill}${infoPart}`, inner, "");
  return `${accent}╭${content}${"─".repeat(Math.max(0, inner - visibleWidth(content)))}╮${RST}`;
}

/** Preserve right-hand widget status; truncate and pad the left-hand content. */
export function borderLine(left: string, right: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}│${RST}`;
  const contentWidth = width - 2;
  const rightVis = visibleWidth(right);
  if (rightVis >= contentWidth) {
    const text = truncateToWidth(right, contentWidth);
    return `${accent}│${RST}${text}${" ".repeat(Math.max(0, contentWidth - visibleWidth(text)))}${accent}│${RST}`;
  }
  const text = truncateToWidth(left, Math.max(0, contentWidth - rightVis));
  const pad = Math.max(0, contentWidth - visibleWidth(text) - rightVis);
  return `${accent}│${RST}${text}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

export function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╰${RST}`;
  return `${accent}╰${"─".repeat(width - 2)}╯${RST}`;
}

/** Full, wrapping card content with the same amber frame for success and failure. */
export function framedMessage(title: string, content: string, background: (text: string) => string): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      // At tiny widths omit padding, and below three columns omit side borders,
      // so framing cannot consume the entire content area.
      const sides = width >= 3;
      const padding = width >= 6 ? 1 : 0;
      const inner = width - (sides ? 2 : 0) - padding * 2;
      const lines = new Text(content, 0, 0).render(inner).map((rawLine) => {
        // A two-column glyph cannot fit in a one-column terminal/content area.
        const line = truncateToWidth(rawLine, inner, "");
        const padded = `${" ".repeat(padding)}${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)) + padding)}`;
        return sides ? borderLine(background(padded), "", width, OPEN_ACCENT) : background(padded);
      });
      return [borderTop(title, "", width, OPEN_ACCENT), ...lines, borderBottom(width, OPEN_ACCENT)];
    },
  };
}
