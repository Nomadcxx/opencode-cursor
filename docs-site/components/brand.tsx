import type { ComponentProps } from 'react';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function Brand({ className, ...props }: ComponentProps<'img'>) {
  return (
    <img
      className={`docs-brand ${className ?? ''}`}
      src={`${basePath}/occ-compact.svg`}
      alt=""
      width="144"
      height="40"
      {...props}
    />
  );
}
