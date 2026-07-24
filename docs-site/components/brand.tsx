import type { ComponentProps } from 'react';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function Brand({ className, ...props }: ComponentProps<'img'>) {
  return (
    <img
      className={`docs-brand ${className ?? ''}`}
      src={`${basePath}/occ-mark.svg`}
      alt=""
      width="649"
      height="196"
      {...props}
    />
  );
}
