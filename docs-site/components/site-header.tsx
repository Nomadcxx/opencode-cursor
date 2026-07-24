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
      </Link>
      <div className="site-header-search">
        <div className="site-search-full">
          <FullSearchTrigger hideIfDisabled />
        </div>
        <SearchTrigger hideIfDisabled aria-label="Open search" className="site-search-icon" />
      </div>
      <div className="site-header-meta">
        <a
          className="site-header-badge"
          href="https://github.com/Nomadcxx/opencode-cursor/stargazers"
          aria-label="opencode-cursor GitHub stars"
        >
          <img
            src="https://img.shields.io/github/stars/Nomadcxx/opencode-cursor?style=flat-square&logo=github&label=stars&color=37f499&labelColor=212337"
            alt="GitHub stars"
            width="85"
            height="20"
          />
        </a>
        <SidebarTrigger className="site-sidebar-trigger" aria-label="Open navigation">
          <PanelLeft aria-hidden="true" />
        </SidebarTrigger>
      </div>
    </header>
  );
}
