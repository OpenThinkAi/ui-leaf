import { createElement } from "react";

export default function Minimal({ data }: { data: unknown }) {
  return createElement("pre", null, JSON.stringify(data));
}
