import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';

type ChildElement = ReactElement<{ children?: ReactNode }>;

function childElements(node: ReactNode): ChildElement[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return Children.toArray(node.props.children).filter(
    (child): child is ChildElement => isValidElement<{ children?: ReactNode }>(child),
  );
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  return Children.toArray(node.props.children).map(textContent).join('').trim();
}

function ResponsiveTable({ children, ...props }: ComponentProps<'table'>) {
  const sections = Children.toArray(children);
  const head = sections.find((section) => isValidElement(section) && section.type === 'thead');
  const headerRow = childElements(head)[0];
  const labels = childElements(headerRow).map(textContent);

  const labelled = Children.map(children, (section) => {
    if (!isValidElement<{ children?: ReactNode }>(section) || section.type !== 'tbody') {
      return section;
    }

    const rows = Children.map(section.props.children, (row) => {
      if (!isValidElement<{ children?: ReactNode }>(row)) return row;
      const cells = Children.map(row.props.children, (cell, index) => {
        if (!isValidElement(cell)) return cell;
        return cloneElement(cell as ReactElement<Record<string, unknown>>, {
          'data-label': labels[index] ?? '',
        });
      });
      return cloneElement(row, undefined, cells);
    });

    return cloneElement(section, undefined, rows);
  });

  return (
    <div className="docs-table" data-responsive-table="true">
      <table {...props}>{labelled}</table>
    </div>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    table: ResponsiveTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
