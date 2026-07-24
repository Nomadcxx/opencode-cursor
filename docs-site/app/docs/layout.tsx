import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { SiteHeader } from '@/components/site-header';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      containerProps={{ className: 'docs-shell' }}
      sidebar={{ defaultOpenLevel: 1 }}
      slots={{ header: SiteHeader }}
    >
      {children}
    </DocsLayout>
  );
}
