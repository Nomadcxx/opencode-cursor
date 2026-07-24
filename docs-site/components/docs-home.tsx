import { Brand } from '@/components/brand';
import Link from 'next/link';

const callsToAction = [
  ['install', 'Install', '/docs/getting-started/installation'],
  ['troubleshooting', 'Troubleshoot', '/docs/getting-started/troubleshooting'],
  ['configuration', 'Configure', '/docs/reference/configuration'],
] as const;

export function DocsHome() {
  return (
    <section className="docs-home-hero" aria-labelledby="docs-index-title" data-docs-index>
      <div className="docs-home-identity">
        <Brand className="docs-home-mark" />
        <div>
          <h1 id="docs-index-title">opencode-cursor</h1>
          <p>Cursor Pro models, inside OpenCode.</p>
        </div>
      </div>
      <nav className="docs-home-actions" aria-label="Get started">
        {callsToAction.map(([marker, title, href]) => (
          <Link key={href} href={href} data-home-command={marker}>
            {title}
          </Link>
        ))}
      </nav>
    </section>
  );
}
