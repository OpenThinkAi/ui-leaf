export default function TrivialView({ data }: { data: unknown; mutate: unknown }) {
  return <div data-testid="trivial">{JSON.stringify(data)}</div>;
}
