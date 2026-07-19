/**
 * A sparse character grid for drawing the workflow graph. Box-drawing
 * characters merge by connectivity (│ crossing ─ becomes ┼) so overlapping
 * edge polylines join instead of overwriting each other.
 */

export type CanvasStyle = "plain" | "dim" | "taken" | "active" | "back" | "ok" | "fail" | "warn";

type CanvasChar = { char: string; style: CanvasStyle };

export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;

/** Which sides each box-drawing character connects to (exported for tests). */
export const CHAR_TO_MASK: Record<string, number> = {
  "─": LEFT | RIGHT,
  "│": UP | DOWN,
  "┌": DOWN | RIGHT,
  "┐": DOWN | LEFT,
  "└": UP | RIGHT,
  "┘": UP | LEFT,
  "├": UP | DOWN | RIGHT,
  "┤": UP | DOWN | LEFT,
  "┬": DOWN | LEFT | RIGHT,
  "┴": UP | LEFT | RIGHT,
  "┼": UP | DOWN | LEFT | RIGHT,
};

const MASK_TO_CHAR = new Map<number, string>(
  Object.entries(CHAR_TO_MASK).map(([char, mask]) => [mask, char]),
);

/** Styles later in this list win when merged lines overlap. */
const STYLE_PRIORITY: CanvasStyle[] = [
  "plain",
  "dim",
  "back",
  "warn",
  "ok",
  "fail",
  "taken",
  "active",
];

function mergeStyles(a: CanvasStyle, b: CanvasStyle): CanvasStyle {
  return STYLE_PRIORITY.indexOf(a) >= STYLE_PRIORITY.indexOf(b) ? a : b;
}

export class CharCanvas {
  private readonly cells = new Map<number, Map<number, CanvasChar>>();
  private maxX = 0;
  private maxY = 0;

  private row(y: number): Map<number, CanvasChar> {
    let row = this.cells.get(y);
    if (!row) {
      row = new Map();
      this.cells.set(y, row);
    }
    this.maxY = Math.max(this.maxY, y);
    return row;
  }

  /** Place a single character, merging box-drawing connectivity. */
  put(x: number, y: number, char: string, style: CanvasStyle = "plain"): void {
    if (x < 0 || y < 0) {
      return;
    }
    const row = this.row(y);
    this.maxX = Math.max(this.maxX, x);
    const existing = row.get(x);
    // Spaces never occupy cells; textOverRun handles deliberate padding.
    if (char === " ") {
      return;
    }
    if (existing) {
      const existingMask = CHAR_TO_MASK[existing.char];
      const incomingMask = CHAR_TO_MASK[char];
      if (existingMask !== undefined && incomingMask !== undefined) {
        row.set(x, {
          char: MASK_TO_CHAR.get(existingMask | incomingMask) ?? char,
          style: mergeStyles(existing.style, style),
        });
        return;
      }
      // Non-line characters (labels, glyphs, arrows) win over lines; between
      // two non-line characters the newest wins.
      if (existingMask === undefined && incomingMask !== undefined) {
        return;
      }
    }
    row.set(x, { char, style });
  }

  /** Write a text run left to right (labels, node lines). */
  text(x: number, y: number, value: string, style: CanvasStyle = "plain"): void {
    for (const [index, char] of [...value].entries()) {
      this.put(x + index, y, char, style);
    }
  }

  /**
   * Write text only when every target cell is empty. Returns whether the
   * text was written. Used for optional decorations (edge labels) that must
   * never corrupt lines or nodes already on the canvas.
   */
  textIfEmpty(x: number, y: number, value: string, style: CanvasStyle = "plain"): boolean {
    if (x < 0 || y < 0) {
      return false;
    }
    const row = this.cells.get(y);
    const width = [...value].length;
    for (let index = 0; index < width; index += 1) {
      if (row?.has(x + index)) {
        return false;
      }
    }
    this.text(x, y, value, style);
    return true;
  }

  /**
   * Write text over a plain horizontal run, replacing `─` cells only.
   * Refuses (returns false) unless every target cell and both flanking
   * cells are exactly `─`, so a label can never overwrite or sit against
   * corners, crossings, or other labels. Spaces in `value` become real
   * blanks, visually breaking the run around the label on purpose.
   */
  textOverRun(x: number, y: number, value: string, style: CanvasStyle = "plain"): boolean {
    if (x < 1 || y < 0) {
      return false;
    }
    const chars = [...value];
    const row = this.cells.get(y);
    for (let index = -1; index <= chars.length; index += 1) {
      if (row?.get(x + index)?.char !== "─") {
        return false;
      }
    }
    for (const [index, char] of chars.entries()) {
      this.row(y).set(x + index, { char, style });
    }
    this.maxX = Math.max(this.maxX, x + chars.length - 1);
    return true;
  }

  hline(y: number, x1: number, x2: number, style: CanvasStyle = "plain"): void {
    const [start, end] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let x = start; x <= end; x += 1) {
      this.put(x, y, "─", style);
    }
  }

  vline(x: number, y1: number, y2: number, style: CanvasStyle = "plain"): void {
    const [start, end] = y1 <= y2 ? [y1, y2] : [y2, y1];
    for (let y = start; y <= end; y += 1) {
      this.put(x, y, "│", style);
    }
  }

  /** Render to lines; `paint` applies terminal styling per character run. */
  render(paint: (text: string, style: CanvasStyle) => string): string[] {
    const lines: string[] = [];
    for (let y = 0; y <= this.maxY; y += 1) {
      const row = this.cells.get(y);
      if (!row || row.size === 0) {
        lines.push("");
        continue;
      }
      let line = "";
      let runText = "";
      let runStyle: CanvasStyle = "plain";
      const flush = () => {
        if (runText.length > 0) {
          line += paint(runText, runStyle);
          runText = "";
        }
      };
      for (let x = 0; x <= this.maxX; x += 1) {
        const cell = row.get(x);
        const char = cell?.char ?? " ";
        const style = cell?.style ?? "plain";
        if (style !== runStyle) {
          flush();
          runStyle = style;
        }
        runText += char;
      }
      flush();
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines;
  }
}
