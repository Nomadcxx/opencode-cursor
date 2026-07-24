import { Brand } from '@/components/brand';
import { basePath } from '@/lib/shared';
import Link from 'next/link';

const callsToAction = [
  ['install', 'Install', '/docs/getting-started/installation'],
  ['troubleshooting', 'Troubleshoot', '/docs/getting-started/troubleshooting'],
  ['configuration', 'Configure', '/docs/reference/configuration'],
] as const;

export function DocsHome() {
  return (
    <section className="docs-home-hero" aria-label="open-cursor documentation" data-docs-index>
      <h1 id="docs-index-title" className="docs-visually-hidden">
        open-cursor
      </h1>
      <div className="docs-home-wordmark" aria-hidden="true">
        <img
          className="docs-home-banner"
          src={`${basePath}/banner.svg`}
          alt=""
          width="828"
          height="165"
        />
      </div>
      <div className="docs-home-mobile-identity" data-docs-mobile-identity aria-hidden="true">
        <Brand className="docs-home-mark" />
        <div>
          <span className="docs-home-mobile-title">open-cursor</span>
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
