// ui-leaf — Customizable browser views, on demand, for any CLI.
// https://github.com/OpenThinkAi/ui-leaf

export interface MountOptions {
  view: string;
  data: unknown;
  mutations?: Record<string, (args: unknown) => unknown | Promise<unknown>>;
  viewsRoot?: string;
  title?: string;
  shell?: "tab" | "app";
  port?: number;
  open?: boolean;
  signal?: AbortSignal;
}

export async function mount(_opts: MountOptions): Promise<void> {
  throw new Error("ui-leaf: mount() is not yet implemented");
}
