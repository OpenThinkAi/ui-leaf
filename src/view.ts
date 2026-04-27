// ui-leaf/view — types for view authors.
//
// Import from `ui-leaf/view` in your views to get typed `data` and a
// generic `mutate<TResult>` that lets you skip the cast at call sites.

export type Mutate = <TResult = unknown>(
  name: string,
  args?: unknown,
) => Promise<TResult>;

export interface ViewProps<TData = unknown> {
  /** Whatever the CLI passed as `data` to mount(). */
  data: TData;
  /**
   * Invoke a mutation handler the CLI registered. Pass a type parameter
   * to type the resolved value:
   *
   *   const r = await mutate<{ count: number }>("increment", { by: 1 });
   */
  mutate: Mutate;
}

/**
 * Server-side mutation handler — what the CLI passes via mount({ mutations }).
 * Re-exported from the runtime entry so there's a single source of truth.
 */
export type { MutationHandler } from "./dev-server.js";
