import { describe, test, expect } from "bun:test";
import { createViewOpQueue } from "../src/internal/view-op-queue.ts";

describe("createViewOpQueue", () => {
  test("runs ops in arrival order even when later ops would finish sooner", async () => {
    const queue = createViewOpQueue();
    const log: string[] = [];

    const op = (label: string, delay: number) => async () => {
      await new Promise<void>((r) => setTimeout(r, delay));
      log.push(label);
    };

    queue(op("first", 30));
    queue(op("second", 1));
    queue(op("third", 10));

    await new Promise<void>((r) => setTimeout(r, 100));
    expect(log).toEqual(["first", "second", "third"]);
  });

  test("a rejecting op does not break the chain — subsequent ops still run", async () => {
    const queue = createViewOpQueue();
    const log: string[] = [];

    queue(async () => {
      log.push("before-throw");
      throw new Error("boom");
    });
    queue(async () => {
      log.push("after-throw");
    });

    await new Promise<void>((r) => setTimeout(r, 50));
    expect(log).toEqual(["before-throw", "after-throw"]);
  });

  test("op N+1 only starts after op N's promise has settled", async () => {
    const queue = createViewOpQueue();
    const log: string[] = [];
    let firstResolved = false;

    queue(async () => {
      log.push("first-start");
      await new Promise<void>((r) => setTimeout(r, 30));
      firstResolved = true;
      log.push("first-end");
    });
    queue(async () => {
      log.push("second-start");
      expect(firstResolved).toBe(true);
      log.push("second-end");
    });

    await new Promise<void>((r) => setTimeout(r, 80));
    expect(log).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});
