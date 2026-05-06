export default function WithJsxView({ data }: { data: unknown; mutate: unknown }) {
  return (
    <div>
      <h1>JSX Works</h1>
      <p>{JSON.stringify(data)}</p>
    </div>
  );
}
