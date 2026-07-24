import { basePath } from '@/lib/shared';
import Link from 'next/link';

// ponytail: Use live README anchors until the matching docs pages ship.
const callsToAction = [
  ['install', 'Install', 'https://github.com/Nomadcxx/opencode-cursor#installation'],
  ['mcp-servers', 'MCP servers', 'https://github.com/Nomadcxx/opencode-cursor#mcp-tool-bridge'],
  ['architecture', 'Architecture', 'https://github.com/Nomadcxx/opencode-cursor#architecture'],
] as const;

const hintLinks = [
  ['Install', '/docs/getting-started/installation'],
  ['Themes', '/docs/configuration/themes'],
  ['Compositors', '/docs/compositors/niri'],
  ['Develop', '/docs/development/architecture'],
] as const;

export function DocsHome() {
  return (
    <section className="docs-home-hero" aria-label="opencode-cursor documentation" data-docs-home>
      <div className="docs-home-masthead">
        <img
          className="docs-home-banner"
          src={`${basePath}/banner.svg`}
          alt="opencode-cursor — Cursor Pro models, inside OpenCode"
          width="828"
          height="165"
        />
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

export function DocsHintStrip() {
  return (
    <nav className="docs-hint-strip" aria-label="Documentation sections">
      <span className="docs-hint-prefix">F1</span>
      {hintLinks.map(([title, href], index) => (
        <span key={href} className="docs-hint-item">
          {index > 0 ? <span className="docs-hint-sep">|</span> : null}
          <Link href={href}>{title}</Link>
        </span>
      ))}
    </nav>
  );
}
