import { type ComponentPropsWithoutRef, type ElementType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type MonoTextProps<T extends ElementType = 'span'> = {
  as?: T
  children: ReactNode
  className?: string
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'children' | 'className'>

export function MonoText<T extends ElementType = 'span'>({
  as,
  children,
  className,
  ...props
}: MonoTextProps<T>) {
  const Comp = as ?? 'span'

  return (
    <Comp className={cn('font-mono', className)} {...props}>
      {children}
    </Comp>
  )
}
