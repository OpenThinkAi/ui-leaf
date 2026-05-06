// Streaming line splitter for stdout chunks. Holds a partial trailing line
// internally until the next newline arrives (AC #5). LF-only — the binary's
// IPC channel never emits CRLF.

export class LineBuffer {
  #partial = "";

  /** Feed a chunk; returns 0..n complete lines (trailing partial is buffered). */
  feed(chunk: string): string[] {
    const merged = this.#partial + chunk;
    const lastNl = merged.lastIndexOf("\n");
    if (lastNl === -1) {
      this.#partial = merged;
      return [];
    }
    const complete = merged.slice(0, lastNl);
    this.#partial = merged.slice(lastNl + 1);
    return complete === "" ? [] : complete.split("\n");
  }

  /** Drain whatever's still buffered (use on stream end). */
  flush(): string[] {
    if (this.#partial === "") return [];
    const out = [this.#partial];
    this.#partial = "";
    return out;
  }
}
