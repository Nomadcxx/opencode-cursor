import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <span className="sidebar-slash-mark" aria-hidden="true">
            MENU////////////
          </span>
          <span className="sr-only">opencode-cursor</span>
        </>
      ),
      url: '/docs',
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    themeSwitch: { enabled: false },
  };
}
