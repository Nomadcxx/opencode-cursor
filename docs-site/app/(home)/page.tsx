import { basePath } from '@/lib/shared';

export default function HomePage() {
  const docsUrl = `${basePath}/docs/`;

  return (
    <main className="root-redirect">
      <meta httpEquiv="refresh" content={`0;url=${docsUrl}`} />
      <p>
        Opening <a href={docsUrl}>opencode-cursor documentation</a>.
      </p>
    </main>
  );
}
