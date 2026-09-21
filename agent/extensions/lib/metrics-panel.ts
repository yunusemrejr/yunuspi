import { isKeyRelease, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@yunuspi/tui';

/** A snapshot remains stable while reading. Resize retains the logical line. */
export function createMetricsPanel(lines: string[], tui: any, theme: any, done: () => void) {
  let offset = 0, height = 1, lastWidth = 0;
  let rows: { text: string; line: number; part: number }[] = [];
  const maxOffset = () => Math.max(0, rows.length - height);
  const move = (delta: number) => { offset = Math.max(0, Math.min(maxOffset(), offset + delta)); tui.requestRender(); };
  return {
    invalidate() {},
    handleMouse(event: any) {
      if (event.type !== 'wheel') return undefined;
      if (Number.isFinite(event.wheelDelta)) move(event.wheelDelta);
      return { handled: true };
    },
    handleInput(key: string) {
      if (isKeyRelease(key)) return;
      if (key === 'q' || matchesKey(key, 'escape') || matchesKey(key, 'enter')) return done();
      const section = ({'1':'Failure evidence','2':'Context traffic','3':'Capabilities and evidence gaps','4':'Hook health','5':'Session activity','6':'Cache, models and costs'} as Record<string,string>)[key];
      if (section) {
        const line = lines.findIndex(text => text.startsWith(section));
        const row = rows.findIndex(item => item.line === line);
        if (row >= 0) move(row - offset);
        return;
      }
      if (key === 'j' || matchesKey(key, 'down')) move(1);
      else if (key === 'k' || matchesKey(key, 'up')) move(-1);
      else if (matchesKey(key, 'pageDown')) move(height);
      else if (matchesKey(key, 'pageUp')) move(-height);
      else if (matchesKey(key, 'home') || key === 'g') move(-Infinity);
      else if (matchesKey(key, 'end') || key === 'G') move(Infinity);
      else {
        const mouse = /^\x1b\[<(\d+);\d+;\d+M$/.exec(key);
        if (mouse && (Number(mouse[1]) & 64) && (Number(mouse[1]) & 3) <= 1) move((Number(mouse[1]) & 1) ? 3 : -3);
      }
    },
    render(width: number) {
      width = Math.max(1, Math.floor(width));
      const terminalRows = Math.max(1, Math.floor(tui.terminal?.rows ?? 24));
      height = Math.max(1, terminalRows - 2);
      if (width !== lastWidth) {
        const anchor = rows[offset];
        rows = lines.flatMap((line, index) => wrapTextWithAnsi(line || ' ', width).map((text, part) => ({ text, line: index, part })));
        if (anchor) {
          const first = rows.findIndex(row => row.line === anchor.line);
          if (first >= 0) offset = first + Math.min(anchor.part, rows.filter(row => row.line === anchor.line).length - 1);
        }
        lastWidth = width;
      }
      offset = Math.min(offset, maxOffset());
      const header = theme.fg('accent', truncateToWidth('Session metrics · 1–6 sections · ↑/↓ PgUp/PgDn · Esc close', width));
      const body = rows.slice(offset, offset + height).map(row => truncateToWidth(row.text, width));
      const footer = theme.fg('dim', truncateToWidth(`${rows.length ? offset + 1 : 0}–${Math.min(rows.length, offset + height)} / ${rows.length} · snapshot`, width));
      return terminalRows === 1 ? [header] : terminalRows === 2 ? [header, footer] : [header, ...body, footer];
    },
  };
}
