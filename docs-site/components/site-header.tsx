'use client';

import { Brand } from '@/components/brand';
import { SidebarTrigger } from 'fumadocs-ui/layouts/docs/slots/sidebar';
import { FullSearchTrigger, SearchTrigger } from 'fumadocs-ui/layouts/shared/slots/search-trigger';
import { PanelLeft } from 'lucide-react';
import Link from 'next/link';
import type { ComponentProps } from 'react';

export function SiteHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header {...props} className={`site-header ${className ?? ''}`}>
      <Link href="/docs" className="site-brand-link" aria-label="opencode-cursor documentation home">
        <Brand />
        <span className="site-brand-name">opencode-cursor</span>
      </Link>
      <div className="site-header-search">
        <div className="site-search-full">
          <FullSearchTrigger hideIfDisabled />
        </div>
        <SearchTrigger hideIfDisabled aria-label="Open search" className="site-search-icon" />
      </div>
      <div className="site-header-meta">
        <a className="site-repo-link" href="https://github.com/Nomadcxx/opencode-cursor">
          GitHub
        </a>
        <SidebarTrigger className="site-sidebar-trigger" aria-label="Open navigation">
          <PanelLeft aria-hidden="true" />
        </SidebarTrigger>
      </div>
    </header>
  );
}
