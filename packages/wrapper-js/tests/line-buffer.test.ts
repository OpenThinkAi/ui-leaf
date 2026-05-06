import { describe, expect, test } from "bun:test";
import { LineBuffer } from "../src/line-buffer.ts";

describe("LineBuffer", () => {
  test("splits multiple complete lines in a single chunk", () => {
    const buf = new LineBuffer();
    expect(buf.feed("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  test("buffers a trailing partial line until the newline arrives", () => {
    const buf = new LineBuffer();
    expect(buf.feed("hello")).toEqual([]);
    expect(buf.feed(", ")).toEqual([]);
    expect(buf.feed("world\n")).toEqual(["hello, world"]);
  });

  test("splits a chunk that contains both complete and partial lines", () => {
    const buf = new LineBuffer();
    expect(buf.feed("a\nbb\ncc")).toEqual(["a", "bb"]);
    expect(buf.feed("c\n")).toEqual(["ccc"]);
  });

  test("empty chunk is a no-op", () => {
    const buf = new LineBuffer();
    expect(buf.feed("")).toEqual([]);
    expect(buf.feed("x\n")).toEqual(["x"]);
  });

  test("flush surfaces any remaining partial line", () => {
    const buf = new LineBuffer();
    buf.feed("partial");
    expect(buf.flush()).toEqual(["partial"]);
    // Subsequent flush is empty.
    expect(buf.flush()).toEqual([]);
  });

  test("chunk that is exactly one newline emits no lines", () => {
    const buf = new LineBuffer();
    expect(buf.feed("\n")).toEqual([]);
  });

  test("multiple lines split byte-by-byte still re-assemble correctly", () => {
    const buf = new LineBuffer();
    const all: string[] = [];
    for (const ch of '{"a":1}\n{"b":2}\n') {
      all.push(...buf.feed(ch));
    }
    expect(all).toEqual(['{"a":1}', '{"b":2}']);
  });
});
