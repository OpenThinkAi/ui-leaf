import { something } from "this-module-does-not-exist-ui-leaf-test-xyz";

export default function BadImportView({ data }: { data: unknown; mutate: unknown }) {
  return <div>{String(something)}{JSON.stringify(data)}</div>;
}
